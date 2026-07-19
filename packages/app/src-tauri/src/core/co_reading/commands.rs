use super::models::*;
use crate::core::state::AppState;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

const PROCESSING_STALE_MS: i64 = 5 * 60 * 1_000;
const SNAPSHOT_BLOCK_LIMIT: i64 = 100;
const RANGE_TAKEOVER_ERROR: &str = "范围阅读已接管，当前普通共读焦点已重新排队";

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
    if block.id.trim().is_empty()
        || block.book_id.trim().is_empty()
        || block.block_key.trim().is_empty()
        || block.focus_key.trim().is_empty()
        || block.text.trim().is_empty()
        || block.text_hash.trim().is_empty()
        || block.cfi.trim().is_empty()
    {
        return Err("文本块 ID、书籍、焦点、正文、正文哈希和 CFI 不能为空".to_string());
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
        focus_key: row.try_get("focus_key")?,
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

fn settings_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<CoReadingSettings, sqlx::Error> {
    Ok(CoReadingSettings {
        book_id: row.try_get("book_id")?,
        status: row.try_get("status")?,
        dwell_seconds: row.try_get("dwell_seconds")?,
        rolling_summary: row.try_get("rolling_summary")?,
        model_provider_id: row.try_get("model_provider_id")?,
        model_id: row.try_get("model_id")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
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

    settings_from_row(&row).map_err(|e| e.to_string())
}

pub async fn update_settings(
    pool: &SqlitePool,
    data: UpdateCoReadingSettingsData,
) -> Result<CoReadingSettings, String> {
    validate_settings(&data.status, data.dwell_seconds)?;
    ensure_settings(pool, &data.book_id).await?;
    let now = chrono::Utc::now().timestamp_millis();

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    if data.status != "paused" {
        let unresolved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM co_reading_range_tasks WHERE book_id=? AND status IN ('running','paused','failed')",
        )
        .bind(&data.book_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if unresolved > 0 {
            return Err("范围阅读进行、暂停或等待续跑期间，普通跟读必须保持暂停".to_string());
        }
    }

    let updated = sqlx::query(
        "UPDATE co_reading_settings SET status = ?, dwell_seconds = ?, rolling_summary = COALESCE(?, rolling_summary), model_provider_id = COALESCE(?, model_provider_id), model_id = COALESCE(?, model_id), updated_at = MAX(updated_at + 1, ?) WHERE book_id = ?",
    )
    .bind(&data.status)
    .bind(data.dwell_seconds)
    .bind(&data.rolling_summary)
    .bind(&data.model_provider_id)
    .bind(&data.model_id)
    .bind(now)
    .bind(&data.book_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新共读设置失败: {e}"))?;
    if updated.rows_affected() != 1 {
        return Err("更新共读设置失败：设置记录已被删除".to_string());
    }

    let row = sqlx::query(
        "SELECT book_id, status, dwell_seconds, rolling_summary, model_provider_id, model_id, created_at, updated_at FROM co_reading_settings WHERE book_id = ?",
    )
    .bind(&data.book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("读取更新后的共读设置失败: {e}"))?;
    let settings = settings_from_row(&row).map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(settings)
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
                id, book_id, block_key, focus_key, section_index, section_label, cfi, text, text_hash,
                dwell_ms, status, unlocked_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(book_id, block_key) DO UPDATE SET
                focus_key = CASE
                    WHEN co_reading_blocks.status IN ('tracking', 'queued')
                         AND excluded.status IN ('tracking', 'queued')
                        THEN excluded.focus_key
                    ELSE co_reading_blocks.focus_key
                END,
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
        .bind(&block.focus_key)
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
    _limit: i64,
) -> Result<Vec<CoReadingBlock>, String> {
    let focus_key: Option<String> = sqlx::query_scalar(
        "SELECT focus_key FROM co_reading_blocks WHERE book_id=? AND status='queued' ORDER BY unlocked_at ASC, created_at ASC LIMIT 1",
    )
    .bind(book_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("读取共读焦点失败: {e}"))?;
    let Some(focus_key) = focus_key else {
        return Ok(Vec::new());
    };
    let rows = sqlx::query(
        "SELECT * FROM co_reading_blocks WHERE book_id = ? AND status = 'queued' AND focus_key = ? ORDER BY unlocked_at ASC, created_at ASC",
    )
    .bind(book_id)
    .bind(focus_key)
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
    let expected = data.block_keys.len();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;

    let ordinary_can_claim: i64 = sqlx::query_scalar(
        r#"
        SELECT CASE WHEN
            EXISTS (
                SELECT 1 FROM co_reading_settings
                WHERE book_id=? AND status='active'
            )
            AND NOT EXISTS (
                SELECT 1 FROM co_reading_range_tasks
                WHERE book_id=? AND status IN ('running','paused','failed')
            )
        THEN 1 ELSE 0 END
        "#,
    )
    .bind(&data.book_id)
    .bind(&data.book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("校验普通共读认领状态失败: {e}"))?;
    if ordinary_can_claim != 1 {
        tx.commit()
            .await
            .map_err(|e| format!("提交事务失败: {e}"))?;
        return Ok(Vec::new());
    }

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
    if claimed.len() != expected {
        return Err("当前页面包含已被处理或不再排队的正文块，未进行部分认领".to_string());
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
    let annotation_map = data.annotations.as_ref();
    let has_legacy_annotation = !data.annotation_id.as_deref().unwrap_or("").is_empty()
        && data
            .annotated_block_key
            .as_ref()
            .is_some_and(|key| data.block_keys.contains(key));
    let has_annotation_map = annotation_map.is_some_and(|items| {
        !items.is_empty()
            && items
                .iter()
                .all(|(key, value)| data.block_keys.contains(key) && !value.trim().is_empty())
    });
    if data.status == "annotated" && !has_legacy_annotation && !has_annotation_map {
        return Err("批注完成状态必须提供本页有效的批注映射".to_string());
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
        let mapped_annotation_id = annotation_map.and_then(|items| items.get(block_key));
        let is_annotated_block = data.status == "annotated"
            && (mapped_annotation_id.is_some()
                || data.annotated_block_key.as_deref() == Some(block_key.as_str()));
        let block_status = if is_annotated_block {
            "annotated"
        } else if data.status == "annotated" {
            "silent"
        } else {
            data.status.as_str()
        };
        let annotation_id = mapped_annotation_id.map(String::as_str).or_else(|| {
            is_annotated_block
                .then_some(data.annotation_id.as_deref())
                .flatten()
        });
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
        let updated = sqlx::query(
            "UPDATE co_reading_settings SET rolling_summary = ?, updated_at = MAX(updated_at + 1, ?) WHERE book_id = ?",
        )
        .bind(summary)
        .bind(now)
        .bind(&data.book_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("更新共读摘要失败: {e}"))?;
        if updated.rows_affected() != 1 {
            return Err("更新共读摘要失败：设置记录已被删除".to_string());
        }
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(())
}

fn context_parts(context: &Option<serde_json::Value>) -> (Option<String>, Option<String>) {
    if let Some(context) = context {
        (
            context
                .get("before")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            context
                .get("after")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        )
    } else {
        (None, None)
    }
}

pub async fn persist_focus(
    pool: &SqlitePool,
    data: PersistCoReadingFocusData,
) -> Result<PersistCoReadingFocusResult, String> {
    if data.book_id.trim().is_empty() || data.block_keys.is_empty() {
        return Err("持久化共读焦点必须包含书籍和正文块".to_string());
    }
    if data.notes.len() > 3 {
        return Err("单个页面最多持久化 3 条共读书评".to_string());
    }

    let mut unique_block_keys = std::collections::HashSet::new();
    for block_key in &data.block_keys {
        if block_key.trim().is_empty() || !unique_block_keys.insert(block_key.as_str()) {
            return Err("共读焦点正文块标识必须非空且唯一".to_string());
        }
    }
    let mut note_ids = std::collections::HashSet::new();
    let mut representative_annotations = std::collections::HashMap::new();
    for note in &data.notes {
        let text_is_valid = note
            .text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty());
        if note.id.trim().is_empty()
            || note.block_key.trim().is_empty()
            || note.cfi.trim().is_empty()
            || note.note.trim().is_empty()
            || !unique_block_keys.contains(note.block_key.as_str())
            || note.r#type != "annotation"
            || !text_is_valid
            || note.style.as_deref() != Some("underline")
            || note.color.as_deref() != Some("blue")
        {
            return Err(
                "共读书评必须是带逐字引文、下划线样式、蓝色和有效 CFI 的 AI 批注".to_string(),
            );
        }
        if !note_ids.insert(note.id.as_str()) {
            return Err("共读笔记 ID 不能重复".to_string());
        }
        representative_annotations
            .entry(note.block_key.clone())
            .or_insert_with(|| note.id.clone());
    }

    ensure_settings(pool, &data.book_id).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;

    let mut blocks = Vec::with_capacity(data.block_keys.len());
    for block_key in &data.block_keys {
        let row =
            sqlx::query("SELECT * FROM co_reading_blocks WHERE book_id = ? AND block_key = ?")
                .bind(&data.book_id)
                .bind(block_key)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| format!("读取共读焦点正文块失败: {e}"))?
                .ok_or_else(|| "共读焦点包含不存在的正文块".to_string())?;
        blocks.push(block_from_row(&row).map_err(|e| e.to_string())?);
    }
    let focus_key = blocks
        .first()
        .map(|block| block.focus_key.as_str())
        .unwrap_or_default();
    if focus_key.trim().is_empty()
        || blocks
            .iter()
            .any(|block| block.focus_key.as_str() != focus_key)
    {
        return Err("一次只能持久化同一个非空页面焦点".to_string());
    }

    let all_processing = blocks.iter().all(|block| block.status == "processing");
    let all_completed_as_requested = blocks.iter().all(|block| {
        let annotation_id = representative_annotations.get(&block.block_key);
        let expected_status = if annotation_id.is_some() {
            "annotated"
        } else {
            "silent"
        };
        let expected_decision = if annotation_id.is_some() {
            "annotate"
        } else {
            "silent"
        };
        block.status == expected_status
            && block.decision.as_deref() == Some(expected_decision)
            && block.annotation_id.as_ref() == annotation_id
            && block.error.is_none()
    });
    if !all_processing && !all_completed_as_requested {
        return Err("共读焦点状态与本次持久化请求冲突".to_string());
    }

    // A completed replay is deliberately checked before this gate: callers that lost
    // an IPC response may still read their already-committed result after range takeover.
    if all_processing {
        let ordinary_can_persist: i64 = sqlx::query_scalar(
            r#"
            SELECT CASE WHEN
                EXISTS (
                    SELECT 1 FROM co_reading_settings
                    WHERE book_id=? AND status='active'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM co_reading_range_tasks
                    WHERE book_id=? AND status IN ('running','paused','failed')
                )
            THEN 1 ELSE 0 END
            "#,
        )
        .bind(&data.book_id)
        .bind(&data.book_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("校验普通共读持久化状态失败: {e}"))?;
        if ordinary_can_persist != 1 {
            let mut requeued = 0;
            for block_key in &data.block_keys {
                requeued += sqlx::query(
                    r#"
                    UPDATE co_reading_blocks
                    SET status='queued', decision=NULL, annotation_id=NULL, error=NULL,
                        processed_at=NULL, updated_at=MAX(updated_at + 1, ?)
                    WHERE book_id=? AND block_key=? AND status='processing'
                    "#,
                )
                .bind(now)
                .bind(&data.book_id)
                .bind(block_key)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("范围接管时恢复普通共读焦点失败: {e}"))?
                .rows_affected();
            }
            if requeued != data.block_keys.len() as u64 {
                return Err("范围接管时普通共读焦点状态发生冲突".to_string());
            }
            tx.commit()
                .await
                .map_err(|e| format!("提交范围接管恢复事务失败: {e}"))?;
            return Err(RANGE_TAKEOVER_ERROR.to_string());
        }
    }

    let mut persisted_notes = Vec::with_capacity(data.notes.len());
    for note in &data.notes {
        let (context_before, context_after) = context_parts(&note.context);
        if all_processing {
            sqlx::query(
                r#"
                INSERT INTO book_notes (
                    id, book_id, type, cfi, text, style, color, author, source_note_id,
                    note, context_before, context_after, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', NULL, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
                "#,
            )
            .bind(&note.id)
            .bind(&data.book_id)
            .bind(&note.r#type)
            .bind(&note.cfi)
            .bind(&note.text)
            .bind(&note.style)
            .bind(&note.color)
            .bind(&note.note)
            .bind(&context_before)
            .bind(&context_after)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("创建共读笔记失败: {e}"))?;
        }
        let matches_existing: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM book_notes
            WHERE id = ? AND book_id = ? AND author = 'ai' AND source_note_id IS NULL
              AND type = ? AND cfi = ?
              AND COALESCE(text, '') = COALESCE(?, '')
              AND COALESCE(style, '') = COALESCE(?, '')
              AND COALESCE(color, '') = COALESCE(?, '')
              AND note = ?
              AND COALESCE(context_before, '') = COALESCE(?, '')
              AND COALESCE(context_after, '') = COALESCE(?, '')
            "#,
        )
        .bind(&note.id)
        .bind(&data.book_id)
        .bind(&note.r#type)
        .bind(&note.cfi)
        .bind(&note.text)
        .bind(&note.style)
        .bind(&note.color)
        .bind(&note.note)
        .bind(&context_before)
        .bind(&context_after)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("校验已有共读笔记失败: {e}"))?;
        if matches_existing != 1 {
            return Err("共读笔记 ID 与其他内容冲突".to_string());
        }
        let row = sqlx::query("SELECT * FROM book_notes WHERE id = ?")
            .bind(&note.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("读取已持久化共读笔记失败: {e}"))?;
        persisted_notes.push(
            crate::core::books::models::BookNote::from_db_row(&row)
                .map_err(|e| format!("解析已持久化共读笔记失败: {e}"))?,
        );
    }

    if all_processing {
        let mut affected = 0;
        for block_key in &data.block_keys {
            let annotation_id = representative_annotations.get(block_key);
            let block_status = if annotation_id.is_some() {
                "annotated"
            } else {
                "silent"
            };
            let decision = if annotation_id.is_some() {
                "annotate"
            } else {
                "silent"
            };
            let result = sqlx::query(
                r#"
                UPDATE co_reading_blocks
                SET status = ?, decision = ?, annotation_id = ?, error = NULL,
                    processed_at = ?, updated_at = ?
                WHERE book_id = ? AND block_key = ? AND status = 'processing'
                "#,
            )
            .bind(block_status)
            .bind(decision)
            .bind(annotation_id)
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
            let updated = sqlx::query(
                "UPDATE co_reading_settings SET rolling_summary = ?, updated_at = MAX(updated_at + 1, ?) WHERE book_id = ?",
            )
            .bind(summary)
            .bind(now)
            .bind(&data.book_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("更新共读摘要失败: {e}"))?;
            if updated.rows_affected() != 1 {
                return Err("更新共读摘要失败：设置记录已被删除".to_string());
            }
        }
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(PersistCoReadingFocusResult {
        notes: persisted_notes,
    })
}

pub async fn release_focus(
    pool: &SqlitePool,
    data: ReleaseCoReadingFocusData,
) -> Result<ReleaseCoReadingFocusResult, String> {
    if data.book_id.trim().is_empty() || data.block_keys.is_empty() {
        return Err("释放共读焦点必须包含书籍和正文块".to_string());
    }
    let mut unique_block_keys = std::collections::HashSet::new();
    if data
        .block_keys
        .iter()
        .any(|key| key.trim().is_empty() || !unique_block_keys.insert(key.as_str()))
    {
        return Err("释放共读焦点的正文块标识必须非空且唯一".to_string());
    }

    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;
    let mut blocks = Vec::with_capacity(data.block_keys.len());
    for block_key in &data.block_keys {
        let row = sqlx::query("SELECT * FROM co_reading_blocks WHERE book_id=? AND block_key=?")
            .bind(&data.book_id)
            .bind(block_key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| format!("读取待释放共读焦点失败: {e}"))?
            .ok_or_else(|| "释放共读焦点包含不存在的正文块".to_string())?;
        blocks.push(block_from_row(&row).map_err(|e| e.to_string())?);
    }
    let focus_key = blocks
        .first()
        .map(|block| block.focus_key.as_str())
        .unwrap_or_default();
    if focus_key.trim().is_empty()
        || blocks
            .iter()
            .any(|block| block.focus_key.as_str() != focus_key)
    {
        return Err("一次只能释放同一个非空页面焦点".to_string());
    }
    let focus_block_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM co_reading_blocks WHERE book_id=? AND focus_key=?",
    )
    .bind(&data.book_id)
    .bind(focus_key)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("校验待释放共读焦点完整性失败: {e}"))?;
    if focus_block_count != data.block_keys.len() as i64 {
        return Err("释放请求必须包含完整页面焦点".to_string());
    }

    let all_processing = blocks.iter().all(|block| block.status == "processing");
    let all_queued = blocks.iter().all(|block| block.status == "queued");
    let all_committed = blocks.iter().all(|block| {
        matches!(block.status.as_str(), "silent" | "annotated") && block.error.is_none()
    });
    if all_committed {
        tx.commit()
            .await
            .map_err(|e| format!("提交释放检查事务失败: {e}"))?;
        return Ok(ReleaseCoReadingFocusResult {
            released: false,
            committed: true,
        });
    }
    if all_queued {
        tx.commit()
            .await
            .map_err(|e| format!("提交幂等释放事务失败: {e}"))?;
        return Ok(ReleaseCoReadingFocusResult {
            released: false,
            committed: false,
        });
    }
    if !all_processing {
        return Err("共读焦点状态发生变化，无法安全释放".to_string());
    }

    let updated = sqlx::query(
        r#"
        UPDATE co_reading_blocks
        SET status='queued', decision=NULL, annotation_id=NULL, error=NULL,
            processed_at=NULL, updated_at=MAX(updated_at + 1, ?)
        WHERE book_id=? AND focus_key=? AND status='processing'
        "#,
    )
    .bind(now)
    .bind(&data.book_id)
    .bind(focus_key)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("释放旧页面共读焦点失败: {e}"))?;
    if updated.rows_affected() != data.block_keys.len() as u64 {
        return Err("释放旧页面共读焦点时状态发生冲突".to_string());
    }
    tx.commit()
        .await
        .map_err(|e| format!("提交旧页面共读释放事务失败: {e}"))?;
    Ok(ReleaseCoReadingFocusResult {
        released: true,
        committed: false,
    })
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

fn diary_source_from_row(
    row: &sqlx::sqlite::SqliteRow,
) -> Result<CoReadingDiarySourceRecord, sqlx::Error> {
    Ok(CoReadingDiarySourceRecord {
        source_key: row.try_get("source_key")?,
        source_kind: row.try_get("source_kind")?,
        source_annotation_id: row.try_get("source_annotation_id")?,
        task_id: row.try_get("task_id")?,
        block_key: row.try_get("block_key")?,
        book_id: row.try_get("book_id")?,
        section_index: row.try_get("section_index")?,
        section_label: row.try_get("section_label")?,
        cfi: row.try_get("cfi")?,
        text: row.try_get("text")?,
        comment: row.try_get("comment")?,
        summary: row.try_get("summary")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        annotation_id: row.try_get("annotation_id")?,
        written_at: row.try_get("written_at")?,
        diary_id: row.try_get("diary_id")?,
    })
}

pub(crate) async fn get_diary_sources(
    pool: &SqlitePool,
    book_id: &str,
) -> Result<Vec<CoReadingDiarySourceRecord>, String> {
    if book_id.trim().is_empty() {
        return Err("书籍 ID 不能为空".to_string());
    }
    let rows = sqlx::query(
        r#"
        WITH diary_sources AS (
            SELECT
                bn.id AS source_key,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM co_reading_footprints footprint
                        WHERE footprint.book_id = bn.book_id AND footprint.annotation_id = bn.id
                    ) THEN 'range'
                    ELSE 'ordinary'
                END AS source_kind,
                bn.id AS source_annotation_id,
                (
                    SELECT footprint.task_id
                    FROM co_reading_footprints footprint
                    WHERE footprint.book_id = bn.book_id AND footprint.annotation_id = bn.id
                    ORDER BY footprint.updated_at DESC, footprint.id ASC
                    LIMIT 1
                ) AS task_id,
                COALESCE(
                    (
                        SELECT block.block_key
                        FROM co_reading_blocks block
                        WHERE block.book_id = bn.book_id AND block.annotation_id = bn.id
                        ORDER BY block.updated_at DESC, block.id ASC
                        LIMIT 1
                    ),
                    (
                        SELECT footprint.block_key
                        FROM co_reading_footprints footprint
                        WHERE footprint.book_id = bn.book_id AND footprint.annotation_id = bn.id
                        ORDER BY footprint.updated_at DESC, footprint.id ASC
                        LIMIT 1
                    )
                ) AS block_key,
                bn.book_id,
                COALESCE(
                    (
                        SELECT block.section_index
                        FROM co_reading_blocks block
                        WHERE block.book_id = bn.book_id AND block.annotation_id = bn.id
                        ORDER BY block.updated_at DESC, block.id ASC
                        LIMIT 1
                    ),
                    (
                        SELECT footprint.section_index
                        FROM co_reading_footprints footprint
                        WHERE footprint.book_id = bn.book_id AND footprint.annotation_id = bn.id
                        ORDER BY footprint.updated_at DESC, footprint.id ASC
                        LIMIT 1
                    ),
                    -1
                ) AS section_index,
                COALESCE(
                    (
                        SELECT block.section_label
                        FROM co_reading_blocks block
                        WHERE block.book_id = bn.book_id AND block.annotation_id = bn.id
                        ORDER BY block.updated_at DESC, block.id ASC
                        LIMIT 1
                    ),
                    (
                        SELECT footprint.section_label
                        FROM co_reading_footprints footprint
                        WHERE footprint.book_id = bn.book_id AND footprint.annotation_id = bn.id
                        ORDER BY footprint.updated_at DESC, footprint.id ASC
                        LIMIT 1
                    ),
                    ''
                ) AS section_label,
                bn.cfi,
                COALESCE(bn.text, '') AS text,
                NULLIF(TRIM(bn.note), '') AS comment,
                (
                    SELECT NULLIF(TRIM(footprint.summary), '')
                    FROM co_reading_footprints footprint
                    WHERE footprint.book_id = bn.book_id AND footprint.annotation_id = bn.id
                    ORDER BY footprint.updated_at DESC, footprint.id ASC
                    LIMIT 1
                ) AS summary,
            'annotated' AS status,
                bn.created_at,
                bn.id AS annotation_id,
                diary.written_at,
                diary.diary_id
            FROM book_notes bn
            LEFT JOIN co_reading_diary_entries diary
                ON diary.book_id = bn.book_id AND diary.source_key = bn.id
            WHERE bn.book_id = ?
              AND bn.author = 'ai'
              AND bn.type = 'annotation'
              AND bn.source_note_id IS NULL

            UNION ALL

            SELECT
                'range:' || footprint.task_id || ':' || footprint.block_key AS source_key,
                'range' AS source_kind,
                footprint.annotation_id AS source_annotation_id,
                footprint.task_id,
                footprint.block_key,
                footprint.book_id,
                footprint.section_index,
                footprint.section_label,
                footprint.cfi,
                COALESCE(footprint.text, '') AS text,
                NULLIF(TRIM(footprint.comment), '') AS comment,
                NULLIF(TRIM(footprint.summary), '') AS summary,
                footprint.status,
                footprint.created_at,
                footprint.annotation_id,
                diary.written_at,
                diary.diary_id
            FROM co_reading_footprints footprint
            LEFT JOIN book_notes bn
                ON bn.id = footprint.annotation_id
               AND bn.book_id = footprint.book_id
               AND bn.author = 'ai'
               AND bn.type = 'annotation'
               AND bn.source_note_id IS NULL
            LEFT JOIN co_reading_diary_entries diary
                ON diary.book_id = footprint.book_id
               AND diary.source_key = 'range:' || footprint.task_id || ':' || footprint.block_key
            WHERE footprint.book_id = ?
              AND bn.id IS NULL
        )
        SELECT *
        FROM diary_sources
        ORDER BY section_index ASC, cfi ASC, created_at ASC, source_key ASC
        "#,
    )
    .bind(book_id)
    .bind(book_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取共读 Agent 日记来源失败: {error}"))?;

    rows.iter()
        .map(diary_source_from_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("转换共读 Agent 日记来源失败: {error}"))
}

pub(crate) async fn mark_diary_written(
    pool: &SqlitePool,
    data: MarkCoReadingDiaryWrittenData,
) -> Result<MarkCoReadingDiaryWrittenResult, String> {
    let book_id = data.book_id.trim();
    let diary_id = data.diary_id.trim();
    if book_id.is_empty() || diary_id.is_empty() {
        return Err("书籍 ID 和 VCP 日记请求 ID 不能为空".to_string());
    }
    if data.source_keys.is_empty() || data.source_keys.len() > 100 {
        return Err("Agent 日记必须包含 1 到 100 条来源记录".to_string());
    }
    let mut source_keys = Vec::with_capacity(data.source_keys.len());
    for source_key in data.source_keys {
        let key = source_key.trim().to_string();
        if key.is_empty() || source_keys.contains(&key) {
            return Err("Agent 日记来源记录不能为空或重复".to_string());
        }
        source_keys.push(key);
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("开启 Agent 日记账本事务失败: {error}"))?;
    let book_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM books WHERE id = ?")
        .bind(book_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| format!("读取日记关联书籍失败: {error}"))?;
    if book_exists != 1 {
        return Err("日记关联书籍不存在".to_string());
    }

    for source_key in &source_keys {
        let eligible: i64 = sqlx::query_scalar(
            r#"
            SELECT CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM book_notes
                    WHERE id = ? AND book_id = ? AND author = 'ai'
                      AND type = 'annotation' AND source_note_id IS NULL
                      AND TRIM(COALESCE(text, '')) <> ''
                      AND TRIM(COALESCE(note, '')) <> ''
                ) THEN 1
                WHEN EXISTS (
                    SELECT 1
                    FROM co_reading_footprints footprint
                    WHERE ('range:' || footprint.task_id || ':' || footprint.block_key) = ?
                      AND footprint.book_id = ?
                      AND footprint.status = 'annotated'
                      AND TRIM(COALESCE(footprint.text, '')) <> ''
                      AND TRIM(COALESCE(footprint.comment, '')) <> ''
                ) THEN 1
                ELSE 0
            END
            "#,
        )
        .bind(source_key)
        .bind(book_id)
        .bind(source_key)
        .bind(book_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| format!("校验 Agent 日记来源失败: {error}"))?;
        if eligible != 1 {
            return Err(format!("共读来源已删除、串书或不再可用: {source_key}"));
        }

        let existing_diary: Option<String> = sqlx::query_scalar(
            "SELECT diary_id FROM co_reading_diary_entries WHERE book_id = ? AND source_key = ?",
        )
        .bind(book_id)
        .bind(source_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| format!("读取 Agent 日记来源账本失败: {error}"))?;
        if existing_diary
            .as_deref()
            .is_some_and(|existing| existing != diary_id)
        {
            return Err(format!("共读来源已由另一篇日记写入: {source_key}"));
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    let mut written_count = 0usize;
    for source_key in &source_keys {
        let inserted = sqlx::query(
            r#"
            INSERT OR IGNORE INTO co_reading_diary_entries
                (id, book_id, source_kind, source_key, written_at, diary_id)
            VALUES (
                ?,
                ?,
                CASE
                    WHEN ? LIKE 'range:%' OR EXISTS (
                        SELECT 1 FROM co_reading_footprints footprint
                        WHERE footprint.book_id = ? AND footprint.annotation_id = ?
                    ) THEN 'range'
                    ELSE 'ordinary'
                END,
                ?,
                ?,
                ?
            )
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(book_id)
        .bind(source_key)
        .bind(book_id)
        .bind(source_key)
        .bind(source_key)
        .bind(now)
        .bind(diary_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("写入 Agent 日记来源账本失败: {error}"))?;
        written_count += inserted.rows_affected() as usize;
    }

    tx.commit()
        .await
        .map_err(|error| format!("提交 Agent 日记账本事务失败: {error}"))?;

    Ok(MarkCoReadingDiaryWrittenResult {
        diary_id: diary_id.to_string(),
        written_count,
    })
}

#[tauri::command]
pub async fn get_co_reading_diary_sources(
    app_handle: AppHandle,
    book_id: String,
) -> Result<Vec<CoReadingDiarySourceRecord>, String> {
    let pool = app_pool(&app_handle).await?;
    get_diary_sources(&pool, &book_id).await
}

#[tauri::command]
pub async fn mark_co_reading_diary_written(
    app_handle: AppHandle,
    data: MarkCoReadingDiaryWrittenData,
) -> Result<MarkCoReadingDiaryWrittenResult, String> {
    let pool = app_pool(&app_handle).await?;
    mark_diary_written(&pool, data).await
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
pub async fn persist_co_reading_focus(
    app_handle: AppHandle,
    data: PersistCoReadingFocusData,
) -> Result<PersistCoReadingFocusResult, String> {
    let pool = app_pool(&app_handle).await?;
    persist_focus(&pool, data).await
}

#[tauri::command]
pub async fn release_co_reading_focus(
    app_handle: AppHandle,
    data: ReleaseCoReadingFocusData,
) -> Result<ReleaseCoReadingFocusResult, String> {
    let pool = app_pool(&app_handle).await?;
    release_focus(&pool, data).await
}

#[tauri::command]
pub async fn retry_co_reading_blocks(
    app_handle: AppHandle,
    data: RetryCoReadingBlocksData,
) -> Result<u64, String> {
    let pool = app_pool(&app_handle).await?;
    retry_blocks(&pool, data).await
}
