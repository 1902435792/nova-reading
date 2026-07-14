use super::models::*;
use crate::core::state::AppState;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};

const PROCESSING_STALE_MS: i64 = 5 * 60 * 1_000;
const SNAPSHOT_BLOCK_LIMIT: i64 = 100;

fn validate_settings(status: &str, dwell_seconds: i64) -> Result<(), String> {
    if !matches!(status, "off" | "active" | "paused") {
        return Err("共读状态必须是 off、active 或 paused".to_string());
    }
    if !(5..=60).contains(&dwell_seconds) {
        return Err("停留阈值必须在 5 到 60 秒之间".to_string());
    }
    Ok(())
}

fn validate_upsert(block: &CoReadingBlockUpsert) -> Result<(), String> {
    if !matches!(block.status.as_str(), "tracking" | "queued") {
        return Err("文本块只能写入 tracking 或 queued 状态".to_string());
    }
    if block.block_key.trim().is_empty()
        || block.text.trim().is_empty()
        || block.cfi.trim().is_empty()
    {
        return Err("文本块标识、正文和 CFI 不能为空".to_string());
    }
    if block.dwell_ms < 0 {
        return Err("停留时间不能为负数".to_string());
    }
    Ok(())
}

fn block_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<CoReadingBlock, sqlx::Error> {
    Ok(CoReadingBlock {
        id: row.try_get("id")?,
        book_id: row.try_get("book_id")?,
        block_key: row.try_get("block_key")?,
        section_index: row.try_get("section_index")?,
        section_label: row.try_get("section_label")?,
        cfi: row.try_get("cfi")?,
        text: row.try_get("text")?,
        text_hash: row.try_get("text_hash")?,
        dwell_ms: row.try_get("dwell_ms")?,
        status: row.try_get("status")?,
        decision: row.try_get("decision")?,
        annotation_id: row.try_get("annotation_id")?,
        error: row.try_get("error")?,
        unlocked_at: row.try_get("unlocked_at")?,
        processed_at: row.try_get("processed_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

async fn app_pool(app_handle: &AppHandle) -> Result<SqlitePool, String> {
    let state = app_handle.state::<AppState>();
    for _ in 0..100 {
        if let Some(pool) = state.db_pool.lock().await.clone() {
            return Ok(pool);
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err("数据库初始化超时".to_string())
}

async fn ensure_settings(pool: &SqlitePool, book_id: &str) -> Result<CoReadingSettings, String> {
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        r#"
        INSERT INTO co_reading_settings
            (book_id, status, dwell_seconds, rolling_summary, model_provider_id, model_id, created_at, updated_at)
        VALUES (?, 'off', 15, '', '', '', ?, ?)
        ON CONFLICT(book_id) DO NOTHING
        "#,
    )
    .bind(book_id)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| format!("初始化共读设置失败: {e}"))?;

    let row = sqlx::query(
        "SELECT book_id, status, dwell_seconds, rolling_summary, model_provider_id, model_id, created_at, updated_at FROM co_reading_settings WHERE book_id = ?",
    )
    .bind(book_id)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("读取共读设置失败: {e}"))?;

    Ok(CoReadingSettings {
        book_id: row.try_get("book_id").map_err(|e| e.to_string())?,
        status: row.try_get("status").map_err(|e| e.to_string())?,
        dwell_seconds: row.try_get("dwell_seconds").map_err(|e| e.to_string())?,
        rolling_summary: row.try_get("rolling_summary").map_err(|e| e.to_string())?,
        model_provider_id: row
            .try_get("model_provider_id")
            .map_err(|e| e.to_string())?,
        model_id: row.try_get("model_id").map_err(|e| e.to_string())?,
        created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
        updated_at: row.try_get("updated_at").map_err(|e| e.to_string())?,
    })
}

pub async fn update_settings(
    pool: &SqlitePool,
    data: UpdateCoReadingSettingsData,
) -> Result<CoReadingSettings, String> {
    validate_settings(&data.status, data.dwell_seconds)?;
    let current = ensure_settings(pool, &data.book_id).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let rolling_summary = data.rolling_summary.unwrap_or(current.rolling_summary);
    let model_provider_id = data.model_provider_id.unwrap_or(current.model_provider_id);
    let model_id = data.model_id.unwrap_or(current.model_id);

    sqlx::query(
        "UPDATE co_reading_settings SET status = ?, dwell_seconds = ?, rolling_summary = ?, model_provider_id = ?, model_id = ?, updated_at = ? WHERE book_id = ?",
    )
    .bind(&data.status)
    .bind(data.dwell_seconds)
    .bind(&rolling_summary)
    .bind(&model_provider_id)
    .bind(&model_id)
    .bind(now)
    .bind(&data.book_id)
    .execute(pool)
    .await
    .map_err(|e| format!("更新共读设置失败: {e}"))?;

    ensure_settings(pool, &data.book_id).await
}

pub async fn upsert_blocks(
    pool: &SqlitePool,
    blocks: Vec<CoReadingBlockUpsert>,
) -> Result<Vec<CoReadingBlock>, String> {
    if blocks.is_empty() {
        return Ok(Vec::new());
    }
    for block in &blocks {
        validate_upsert(block)?;
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    for block in &blocks {
        sqlx::query(
            r#"
            INSERT INTO co_reading_blocks (
                id, book_id, block_key, section_index, section_label, cfi, text, text_hash,
                dwell_ms, status, unlocked_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id, block_key) DO UPDATE SET
                dwell_ms = MAX(co_reading_blocks.dwell_ms, excluded.dwell_ms),
                status = CASE
                    WHEN co_reading_blocks.status IN ('processing', 'silent', 'annotated', 'failed')
                        THEN co_reading_blocks.status
                    WHEN co_reading_blocks.status = 'queued' OR excluded.status = 'queued'
                        THEN 'queued'
                    ELSE 'tracking'
                END,
                unlocked_at = COALESCE(co_reading_blocks.unlocked_at, excluded.unlocked_at),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(&block.id)
        .bind(&block.book_id)
        .bind(&block.block_key)
        .bind(block.section_index)
        .bind(&block.section_label)
        .bind(&block.cfi)
        .bind(&block.text)
        .bind(&block.text_hash)
        .bind(block.dwell_ms)
        .bind(&block.status)
        .bind(block.unlocked_at)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("保存共读文本块失败: {e}"))?;
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;

    let mut saved = Vec::with_capacity(blocks.len());
    for block in blocks {
        let row =
            sqlx::query("SELECT * FROM co_reading_blocks WHERE book_id = ? AND block_key = ?")
                .bind(&block.book_id)
                .bind(&block.block_key)
                .fetch_one(pool)
                .await
                .map_err(|e| format!("读取共读文本块失败: {e}"))?;
        saved.push(block_from_row(&row).map_err(|e| e.to_string())?);
    }
    Ok(saved)
}

pub async fn queued_blocks(
    pool: &SqlitePool,
    book_id: &str,
    limit: i64,
) -> Result<Vec<CoReadingBlock>, String> {
    let limit = limit.clamp(1, 100);
    let rows = sqlx::query(
        "SELECT * FROM co_reading_blocks WHERE book_id = ? AND status = 'queued' ORDER BY unlocked_at ASC, created_at ASC LIMIT ?",
    )
    .bind(book_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取共读队列失败: {e}"))?;

    rows.iter()
        .map(block_from_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub async fn claim_blocks(
    pool: &SqlitePool,
    data: ClaimCoReadingBlocksData,
) -> Result<Vec<CoReadingBlock>, String> {
    if data.block_keys.is_empty() {
        return Ok(Vec::new());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let mut claimed = Vec::new();

    for block_key in data.block_keys {
        let result = sqlx::query(
            "UPDATE co_reading_blocks SET status = 'processing', error = NULL, updated_at = ? WHERE book_id = ? AND block_key = ? AND status = 'queued'",
        )
        .bind(now)
        .bind(&data.book_id)
        .bind(&block_key)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("认领共读文本块失败: {e}"))?;

        if result.rows_affected() == 1 {
            let row =
                sqlx::query("SELECT * FROM co_reading_blocks WHERE book_id = ? AND block_key = ?")
                    .bind(&data.book_id)
                    .bind(&block_key)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| format!("读取已认领文本块失败: {e}"))?;
            claimed.push(block_from_row(&row).map_err(|e| e.to_string())?);
        }
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(claimed)
}

pub async fn complete_batch(
    pool: &SqlitePool,
    data: CompleteCoReadingBatchData,
) -> Result<(), String> {
    if !matches!(data.status.as_str(), "silent" | "annotated" | "failed") {
        return Err("完成状态必须是 silent、annotated 或 failed".to_string());
    }
    if data.status == "annotated" && data.annotation_id.as_deref().unwrap_or("").is_empty() {
        return Err("批注完成状态必须提供 annotationId".to_string());
    }
    if data.status == "annotated"
        && !data
            .annotated_block_key
            .as_ref()
            .is_some_and(|key| data.block_keys.contains(key))
    {
        return Err("批注完成状态必须指定本批中的 annotatedBlockKey".to_string());
    }
    if data.status == "failed" && data.error.as_deref().unwrap_or("").trim().is_empty() {
        return Err("失败状态必须提供错误信息".to_string());
    }
    if data.block_keys.is_empty() {
        return Err("完成批次不能为空".to_string());
    }
    ensure_settings(pool, &data.book_id).await?;

    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let mut affected = 0;
    for block_key in &data.block_keys {
        let is_annotated_block = data.status == "annotated"
            && data.annotated_block_key.as_deref() == Some(block_key.as_str());
        let block_status = if is_annotated_block {
            "annotated"
        } else if data.status == "annotated" {
            "silent"
        } else {
            data.status.as_str()
        };
        let annotation_id = is_annotated_block
            .then_some(data.annotation_id.as_deref())
            .flatten();
        let block_decision = if data.status == "annotated" && !is_annotated_block {
            Some("silent")
        } else {
            data.decision.as_deref()
        };
        let result = sqlx::query(
            r#"
            UPDATE co_reading_blocks
            SET status = ?, decision = ?, annotation_id = ?, error = ?, processed_at = ?, updated_at = ?
            WHERE book_id = ? AND block_key = ? AND status = 'processing'
            "#,
        )
        .bind(block_status)
        .bind(block_decision)
        .bind(annotation_id)
        .bind(&data.error)
        .bind(now)
        .bind(now)
        .bind(&data.book_id)
        .bind(block_key)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("完成共读文本块失败: {e}"))?;
        affected += result.rows_affected();
    }
    if affected != data.block_keys.len() as u64 {
        return Err("批次中包含未认领或已完成的文本块".to_string());
    }

    if let Some(summary) = data.rolling_summary {
        sqlx::query(
            "UPDATE co_reading_settings SET rolling_summary = ?, updated_at = ? WHERE book_id = ?",
        )
        .bind(summary)
        .bind(now)
        .bind(&data.book_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("更新共读摘要失败: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(())
}

pub async fn retry_blocks(
    pool: &SqlitePool,
    data: RetryCoReadingBlocksData,
) -> Result<u64, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let mut affected = 0;
    for block_key in data.block_keys {
        affected += sqlx::query(
            "UPDATE co_reading_blocks SET status = 'queued', decision = NULL, error = NULL, processed_at = NULL, updated_at = ? WHERE book_id = ? AND block_key = ? AND status = 'failed'",
        )
        .bind(now)
        .bind(&data.book_id)
        .bind(block_key)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("重试共读文本块失败: {e}"))?
        .rows_affected();
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(affected)
}

pub async fn get_snapshot(
    pool: &SqlitePool,
    book_id: &str,
    stale_after_ms: i64,
) -> Result<CoReadingSnapshot, String> {
    let settings = ensure_settings(pool, book_id).await?;
    let stale_before = chrono::Utc::now().timestamp_millis() - stale_after_ms.max(0);
    sqlx::query(
        "UPDATE co_reading_blocks SET status = 'queued', error = NULL, updated_at = ? WHERE book_id = ? AND status = 'processing' AND updated_at <= ?",
    )
    .bind(chrono::Utc::now().timestamp_millis())
    .bind(book_id)
    .bind(stale_before)
    .execute(pool)
    .await
    .map_err(|e| format!("恢复中断共读任务失败: {e}"))?;

    let count_rows = sqlx::query(
        "SELECT status, COUNT(*) AS count FROM co_reading_blocks WHERE book_id = ? GROUP BY status",
    )
    .bind(book_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取共读统计失败: {e}"))?;
    let mut stats = CoReadingStats::default();
    for row in count_rows {
        let status: String = row.try_get("status").map_err(|e| e.to_string())?;
        let count: i64 = row.try_get("count").map_err(|e| e.to_string())?;
        match status.as_str() {
            "tracking" => stats.tracking = count,
            "queued" => stats.queued = count,
            "processing" => stats.processing = count,
            "silent" => stats.silent = count,
            "annotated" => stats.annotated = count,
            "failed" => stats.failed = count,
            _ => {}
        }
    }

    let rows = sqlx::query(
        "SELECT * FROM co_reading_blocks WHERE book_id = ? ORDER BY updated_at DESC LIMIT ?",
    )
    .bind(book_id)
    .bind(SNAPSHOT_BLOCK_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取共读快照失败: {e}"))?;
    let blocks = rows
        .iter()
        .map(block_from_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(CoReadingSnapshot {
        settings,
        stats,
        blocks,
    })
}

#[tauri::command]
pub async fn get_co_reading_snapshot(
    app_handle: AppHandle,
    book_id: String,
) -> Result<CoReadingSnapshot, String> {
    let pool = app_pool(&app_handle).await?;
    get_snapshot(&pool, &book_id, PROCESSING_STALE_MS).await
}

#[tauri::command]
pub async fn update_co_reading_settings(
    app_handle: AppHandle,
    data: UpdateCoReadingSettingsData,
) -> Result<CoReadingSettings, String> {
    let pool = app_pool(&app_handle).await?;
    update_settings(&pool, data).await
}

#[tauri::command]
pub async fn upsert_co_reading_blocks(
    app_handle: AppHandle,
    blocks: Vec<CoReadingBlockUpsert>,
) -> Result<Vec<CoReadingBlock>, String> {
    let pool = app_pool(&app_handle).await?;
    upsert_blocks(&pool, blocks).await
}

#[tauri::command]
pub async fn get_queued_co_reading_blocks(
    app_handle: AppHandle,
    book_id: String,
    limit: Option<i64>,
) -> Result<Vec<CoReadingBlock>, String> {
    let pool = app_pool(&app_handle).await?;
    queued_blocks(&pool, &book_id, limit.unwrap_or(20)).await
}

#[tauri::command]
pub async fn claim_co_reading_blocks(
    app_handle: AppHandle,
    data: ClaimCoReadingBlocksData,
) -> Result<Vec<CoReadingBlock>, String> {
    let pool = app_pool(&app_handle).await?;
    claim_blocks(&pool, data).await
}

#[tauri::command]
pub async fn complete_co_reading_batch(
    app_handle: AppHandle,
    data: CompleteCoReadingBatchData,
) -> Result<(), String> {
    let pool = app_pool(&app_handle).await?;
    complete_batch(&pool, data).await
}

#[tauri::command]
pub async fn retry_co_reading_blocks(
    app_handle: AppHandle,
    data: RetryCoReadingBlocksData,
) -> Result<u64, String> {
    let pool = app_pool(&app_handle).await?;
    retry_blocks(&pool, data).await
}
