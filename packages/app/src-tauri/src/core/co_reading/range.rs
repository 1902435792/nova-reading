use super::models::*;
use crate::core::state::AppState;
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

fn task_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<CoReadingRangeTask, sqlx::Error> {
    Ok(CoReadingRangeTask {
        id: row.try_get("id")?,
        book_id: row.try_get("book_id")?,
        format: row.try_get("format")?,
        range_kind: row.try_get("range_kind")?,
        start_index: row.try_get("start_index")?,
        end_index: row.try_get("end_index")?,
        start_label: row.try_get("start_label")?,
        end_label: row.try_get("end_label")?,
        start_char_offset: row.try_get("start_char_offset")?,
        end_char_offset: row.try_get("end_char_offset")?,
        start_percent: row.try_get("start_percent")?,
        end_percent: row.try_get("end_percent")?,
        status: row.try_get("status")?,
        previous_follow_status: row.try_get("previous_follow_status")?,
        candidate_limit: row.try_get("candidate_limit")?,
        per_section_limit: row.try_get("per_section_limit")?,
        request_limit: row.try_get("request_limit")?,
        scanned_count: row.try_get("scanned_count")?,
        selected_count: row.try_get("selected_count")?,
        processed_count: row.try_get("processed_count")?,
        request_count: row.try_get("request_count")?,
        cursor_index: row.try_get("cursor_index")?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        completed_at: row.try_get("completed_at")?,
    })
}

fn footprint_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<CoReadingFootprint, sqlx::Error> {
    Ok(CoReadingFootprint {
        id: row.try_get("id")?,
        task_id: row.try_get("task_id")?,
        book_id: row.try_get("book_id")?,
        block_key: row.try_get("block_key")?,
        section_index: row.try_get("section_index")?,
        section_label: row.try_get("section_label")?,
        cfi: row.try_get("cfi")?,
        text: row.try_get("text")?,
        text_hash: row.try_get("text_hash")?,
        status: row.try_get("status")?,
        reason: row.try_get("reason")?,
        summary: row.try_get("summary")?,
        comment: row.try_get("comment")?,
        annotation_id: row.try_get("annotation_id")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        processed_at: row.try_get("processed_at")?,
    })
}

async fn app_pool(app: &AppHandle) -> Result<SqlitePool, String> {
    let state = app.state::<AppState>();
    for _ in 0..100 {
        if let Some(pool) = state.db_pool.lock().await.clone() {
            return Ok(pool);
        }
        sleep(Duration::from_millis(50)).await;
    }
    Err("数据库初始化超时".into())
}

pub async fn create_task(
    pool: &SqlitePool,
    data: CreateCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    if !matches!(data.format.as_str(), "EPUB" | "PDF") {
        return Err("范围阅读首版仅支持 EPUB 和 PDF".into());
    }
    let expected_kind = if data.format == "PDF" {
        "page"
    } else {
        "section"
    };
    if data.range_kind != expected_kind {
        return Err("书籍格式与范围类型不匹配".into());
    }
    if data.start_index < 0 || data.end_index < data.start_index {
        return Err("阅读范围无效".into());
    }
    let percentage_fields = [
        data.start_char_offset.is_some(),
        data.end_char_offset.is_some(),
        data.start_percent.is_some(),
        data.end_percent.is_some(),
    ];
    if percentage_fields.iter().any(|value| *value) && !percentage_fields.iter().all(|value| *value)
    {
        return Err("百分比范围边界不完整".into());
    }
    if let (Some(start_char), Some(end_char), Some(start_percent), Some(end_percent)) = (
        data.start_char_offset,
        data.end_char_offset,
        data.start_percent,
        data.end_percent,
    ) {
        if start_char < 0
            || end_char < 0
            || !(0.0..=100.0).contains(&start_percent)
            || !(0.0..=100.0).contains(&end_percent)
            || start_percent >= end_percent
            || (data.start_index == data.end_index && start_char >= end_char)
        {
            return Err("百分比阅读范围无效".into());
        }
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        r#"
        INSERT INTO co_reading_settings
            (book_id, status, dwell_seconds, rolling_summary, model_provider_id, model_id, created_at, updated_at)
        VALUES (?, 'off', 15, '', '', '', ?, ?)
        ON CONFLICT(book_id) DO NOTHING
        "#,
    )
    .bind(&data.book_id)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("初始化共读设置失败: {e}"))?;

    let settings_row =
        sqlx::query("SELECT status, updated_at FROM co_reading_settings WHERE book_id=?")
            .bind(&data.book_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("读取共读设置失败: {e}"))?;
    let previous_status: String = settings_row.try_get("status").map_err(|e| e.to_string())?;
    if !matches!(previous_status.as_str(), "off" | "active" | "paused") {
        return Err("普通跟读状态无效，无法创建范围阅读任务".into());
    }
    let settings_updated_at: i64 = settings_row
        .try_get("updated_at")
        .map_err(|e| e.to_string())?;

    let unresolved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM co_reading_range_tasks WHERE book_id=? AND status IN ('running','paused','failed')",
    )
    .bind(&data.book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if unresolved > 0 {
        return Err("本书已有未解决的范围阅读任务，请先续跑或停止该任务".into());
    }

    let id = Uuid::new_v4().to_string();
    let range_count = data
        .end_index
        .saturating_sub(data.start_index)
        .saturating_add(1);
    // The two extra requests are fixed retry headroom established at creation time.
    // Resuming a failed task must never grow this budget.
    let request_limit = range_count.saturating_add(2).max(8);
    let inserted = sqlx::query("INSERT INTO co_reading_range_tasks (id,book_id,format,range_kind,start_index,end_index,start_label,end_label,start_char_offset,end_char_offset,start_percent,end_percent,status,previous_follow_status,request_limit,cursor_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'running',?,?,?,?,?)")
        .bind(&id).bind(&data.book_id).bind(&data.format).bind(&data.range_kind).bind(data.start_index).bind(data.end_index)
        .bind(&data.start_label).bind(&data.end_label).bind(data.start_char_offset).bind(data.end_char_offset)
        .bind(data.start_percent).bind(data.end_percent).bind(&previous_status).bind(request_limit).bind(data.start_index).bind(now).bind(now)
        .execute(&mut *tx).await.map_err(|e| format!("创建范围阅读任务失败: {e}"))?;
    if inserted.rows_affected() != 1 {
        return Err("创建范围阅读任务失败：任务未写入".into());
    }

    let settings_now = now.max(settings_updated_at.saturating_add(1));
    let paused =
        sqlx::query("UPDATE co_reading_settings SET status='paused', updated_at=? WHERE book_id=?")
            .bind(settings_now)
            .bind(&data.book_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("暂停普通跟读失败: {e}"))?;
    if paused.rows_affected() != 1 {
        return Err("暂停普通跟读失败：共读设置已被删除".into());
    }

    let row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| format!("读取已创建范围阅读任务失败: {e}"))?;
    let task = task_from_row(&row).map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(task)
}

pub async fn get_task(pool: &SqlitePool, id: &str) -> Result<CoReadingRangeTask, String> {
    let row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    task_from_row(&row).map_err(|e| e.to_string())
}

pub async fn snapshot(pool: &SqlitePool, book_id: &str) -> Result<CoReadingRangeSnapshot, String> {
    let task_rows = sqlx::query(
        "SELECT * FROM co_reading_range_tasks WHERE book_id=? ORDER BY created_at DESC",
    )
    .bind(book_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let foot_rows = sqlx::query(
        "SELECT * FROM co_reading_footprints WHERE book_id=? ORDER BY section_index, created_at",
    )
    .bind(book_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(CoReadingRangeSnapshot {
        tasks: task_rows
            .iter()
            .map(task_from_row)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
        footprints: foot_rows
            .iter()
            .map(footprint_from_row)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?,
    })
}

pub async fn set_task_status(
    pool: &SqlitePool,
    data: UpdateCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    if !matches!(
        data.status.as_str(),
        "running" | "paused" | "completed" | "stopped" | "failed"
    ) {
        return Err("范围任务状态无效".into());
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&data.task_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| "范围阅读任务不存在".to_string())?;
    let current = task_from_row(&row).map_err(|e| e.to_string())?;
    if current.status == data.status {
        tx.commit().await.map_err(|e| e.to_string())?;
        return Ok(current);
    }
    if data.expected_updated_at != current.updated_at {
        return Err("范围阅读任务已被其他操作更新，请刷新后重试".into());
    }

    if matches!(current.status.as_str(), "completed" | "stopped") {
        return Err(format!(
            "范围阅读任务已{}，不能转换为{}",
            if current.status == "completed" {
                "完成"
            } else {
                "停止"
            },
            data.status
        ));
    }

    let valid_transition = match data.status.as_str() {
        "running" => matches!(current.status.as_str(), "paused" | "failed"),
        "paused" => current.status == "running",
        "failed" => current.status == "running",
        "completed" => current.status == "running",
        "stopped" => matches!(current.status.as_str(), "running" | "paused" | "failed"),
        _ => false,
    };
    if !valid_transition {
        return Err(format!(
            "范围阅读任务不能从{}转换为{}",
            current.status, data.status
        ));
    }
    if data.status == "running" {
        let other_unresolved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM co_reading_range_tasks WHERE book_id=? AND id<>? AND status IN ('running','paused','failed')",
        )
        .bind(&current.book_id)
        .bind(&current.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if other_unresolved > 0 {
            return Err("本书已有其他未解决的范围阅读任务".into());
        }
    }

    let error = if data.status == "failed" {
        let trimmed = data.error.as_deref().unwrap_or("").trim();
        if trimmed.is_empty() {
            return Err("范围阅读失败必须提供非空错误信息".into());
        }
        Some(trimmed.to_string())
    } else {
        None
    };
    if data.status == "completed" {
        let expected_cursor = current
            .end_index
            .checked_add(1)
            .ok_or_else(|| "范围阅读结束位置无效".to_string())?;
        if current.cursor_index != expected_cursor {
            return Err("范围阅读尚未到达结束位置，不能标记完成".into());
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    let next_updated_at = now.max(current.updated_at.saturating_add(1));
    let completed_at = match data.status.as_str() {
        "failed" | "completed" | "stopped" => Some(now),
        "running" | "paused" => None,
        _ => None,
    };
    let task_update = sqlx::query(
        r#"
        UPDATE co_reading_range_tasks
        SET status=?, error=?, completed_at=?, updated_at=?
        WHERE id=? AND status=? AND updated_at=?
        "#,
    )
    .bind(&data.status)
    .bind(&error)
    .bind(completed_at)
    .bind(next_updated_at)
    .bind(&current.id)
    .bind(&current.status)
    .bind(current.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if task_update.rows_affected() != 1 {
        return Err("范围阅读任务已被其他操作更新，请刷新后重试".into());
    }

    let settings_row = sqlx::query("SELECT updated_at FROM co_reading_settings WHERE book_id=?")
        .bind(&current.book_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| "范围阅读对应的共读设置不存在".to_string())?;
    let settings_updated_at: i64 = settings_row
        .try_get("updated_at")
        .map_err(|e| e.to_string())?;
    let settings_status = if matches!(data.status.as_str(), "running" | "paused" | "failed") {
        "paused"
    } else {
        current.previous_follow_status.as_str()
    };
    let settings_update_at = now.max(settings_updated_at.saturating_add(1));
    let settings_update =
        sqlx::query("UPDATE co_reading_settings SET status=?, updated_at=? WHERE book_id=?")
            .bind(settings_status)
            .bind(settings_update_at)
            .bind(&current.book_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    if settings_update.rows_affected() != 1 {
        return Err("范围阅读共读设置更新失败".into());
    }

    let updated_row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&current.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let updated = task_from_row(&updated_row).map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(updated)
}

pub async fn upsert_footprints(
    pool: &SqlitePool,
    items: Vec<CoReadingFootprintUpsert>,
) -> Result<Vec<CoReadingFootprint>, String> {
    let now = chrono::Utc::now().timestamp_millis();
    for item in &items {
        if !matches!(
            item.status.as_str(),
            "filtered" | "candidate" | "selected" | "silent" | "annotated" | "failed"
        ) {
            return Err("阅读足迹状态无效".into());
        }
        sqlx::query("INSERT INTO co_reading_footprints (id,task_id,book_id,block_key,section_index,section_label,cfi,text,text_hash,status,reason,summary,comment,annotation_id,created_at,updated_at,processed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,block_key) DO UPDATE SET status=excluded.status,reason=excluded.reason,summary=excluded.summary,comment=excluded.comment,annotation_id=excluded.annotation_id,updated_at=excluded.updated_at,processed_at=excluded.processed_at")
            .bind(&item.id).bind(&item.task_id).bind(&item.book_id).bind(&item.block_key).bind(item.section_index).bind(&item.section_label)
            .bind(&item.cfi).bind(&item.text).bind(&item.text_hash).bind(&item.status).bind(&item.reason).bind(&item.summary)
            .bind(&item.comment).bind(&item.annotation_id).bind(now).bind(now).bind(item.processed_at)
            .execute(pool).await.map_err(|e| e.to_string())?;
    }
    let mut saved = Vec::new();
    for item in items {
        let row =
            sqlx::query("SELECT * FROM co_reading_footprints WHERE task_id=? AND block_key=?")
                .bind(&item.task_id)
                .bind(&item.block_key)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        saved.push(footprint_from_row(&row).map_err(|e| e.to_string())?);
    }
    Ok(saved)
}

fn range_context_parts(context: &Option<serde_json::Value>) -> (Option<String>, Option<String>) {
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

fn validate_range_progress(
    current: &CoReadingRangeTask,
    expected_updated_at: i64,
    cursor_index: i64,
    scanned_delta: i64,
    selected_delta: i64,
    processed_delta: i64,
    request_delta: i64,
) -> Result<(i64, i64, i64, i64), String> {
    if current.status != "running" {
        return Err("只有进行中的范围阅读任务可以持久化章节".to_string());
    }
    if expected_updated_at != current.updated_at {
        return Err("范围阅读任务已停止或被其他操作更新".to_string());
    }
    if scanned_delta < 0 || selected_delta < 0 || processed_delta < 0 || request_delta < 0 {
        return Err("范围阅读进度增量不能为负数".to_string());
    }
    let max_cursor = current
        .end_index
        .checked_add(1)
        .ok_or_else(|| "范围阅读结束位置无效".to_string())?;
    if cursor_index < current.cursor_index || cursor_index > max_cursor {
        return Err("范围阅读游标必须单调且位于当前范围内".to_string());
    }
    let next_request_count = current
        .request_count
        .checked_add(request_delta)
        .ok_or_else(|| "范围阅读请求计数溢出".to_string())?;
    if next_request_count > current.request_limit {
        return Err("范围阅读请求预算不足".to_string());
    }
    let next_scanned = current
        .scanned_count
        .checked_add(scanned_delta)
        .ok_or_else(|| "范围阅读扫描计数溢出".to_string())?;
    let next_selected = current
        .selected_count
        .checked_add(selected_delta)
        .ok_or_else(|| "范围阅读选取计数溢出".to_string())?;
    let next_processed = current
        .processed_count
        .checked_add(processed_delta)
        .ok_or_else(|| "范围阅读处理计数溢出".to_string())?;
    Ok((
        next_scanned,
        next_selected,
        next_processed,
        next_request_count,
    ))
}

fn validate_range_footprint_identity(
    task: &CoReadingRangeTask,
    item: &CoReadingFootprintUpsert,
) -> Result<(), String> {
    if item.task_id != task.id || item.book_id != task.book_id {
        return Err("范围阅读足迹与任务或书籍不匹配".to_string());
    }
    if item.id.trim().is_empty()
        || item.block_key.trim().is_empty()
        || item.cfi.trim().is_empty()
        || item.text.trim().is_empty()
        || item.text_hash.trim().is_empty()
    {
        return Err("范围阅读足迹 ID、正文块、CFI、正文和哈希不能为空".to_string());
    }
    Ok(())
}

async fn upsert_range_footprints_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    items: &[CoReadingFootprintUpsert],
    now: i64,
) -> Result<Vec<CoReadingFootprint>, String> {
    for item in items {
        let result = sqlx::query("INSERT INTO co_reading_footprints (id,task_id,book_id,block_key,section_index,section_label,cfi,text,text_hash,status,reason,summary,comment,annotation_id,created_at,updated_at,processed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,block_key) DO UPDATE SET status=excluded.status,reason=excluded.reason,summary=excluded.summary,comment=excluded.comment,annotation_id=excluded.annotation_id,updated_at=excluded.updated_at,processed_at=excluded.processed_at")
            .bind(&item.id)
            .bind(&item.task_id)
            .bind(&item.book_id)
            .bind(&item.block_key)
            .bind(item.section_index)
            .bind(&item.section_label)
            .bind(&item.cfi)
            .bind(&item.text)
            .bind(&item.text_hash)
            .bind(&item.status)
            .bind(&item.reason)
            .bind(&item.summary)
            .bind(&item.comment)
            .bind(&item.annotation_id)
            .bind(now)
            .bind(now)
            .bind(item.processed_at)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("保存范围阅读足迹失败: {e}"))?;
        if result.rows_affected() != 1 {
            return Err("保存范围阅读足迹失败".to_string());
        }
    }

    let mut saved = Vec::with_capacity(items.len());
    for item in items {
        let row =
            sqlx::query("SELECT * FROM co_reading_footprints WHERE task_id=? AND block_key=?")
                .bind(&item.task_id)
                .bind(&item.block_key)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| format!("读取范围阅读足迹失败: {e}"))?;
        saved.push(footprint_from_row(&row).map_err(|e| e.to_string())?);
    }
    Ok(saved)
}

pub async fn persist_range_section(
    pool: &SqlitePool,
    data: PersistCoReadingRangeSectionData,
) -> Result<PersistCoReadingRangeSectionResult, String> {
    if data.task_id.trim().is_empty() {
        return Err("范围阅读任务 ID 不能为空".to_string());
    }
    if data.notes.len() > 3 {
        return Err("单个范围章节最多持久化 3 条共读书评".to_string());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&data.task_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "范围阅读任务不存在".to_string())?;
    let current = task_from_row(&row).map_err(|e| e.to_string())?;
    let (next_scanned, next_selected, next_processed, next_request_count) =
        validate_range_progress(
            &current,
            data.expected_updated_at,
            data.cursor_index,
            data.scanned_delta,
            data.selected_delta,
            data.processed_delta,
            data.request_delta,
        )?;

    let expected_cursor = current
        .cursor_index
        .checked_add(1)
        .ok_or_else(|| "范围阅读游标溢出".to_string())?;
    if data.cursor_index != expected_cursor {
        return Err("成功章节必须恰好提交当前完整章节并前进一个游标".to_string());
    }
    let footprint_count =
        i64::try_from(data.footprints.len()).map_err(|_| "范围阅读足迹数量溢出".to_string())?;
    let final_candidate_count = i64::try_from(
        data.footprints
            .iter()
            .filter(|footprint| matches!(footprint.status.as_str(), "silent" | "annotated"))
            .count(),
    )
    .map_err(|_| "范围阅读候选数量溢出".to_string())?;
    if data.scanned_delta != footprint_count
        || data.selected_delta != final_candidate_count
        || data.processed_delta != final_candidate_count
    {
        return Err("范围阅读章节计数与完整终态足迹不一致".to_string());
    }

    let mut block_keys = std::collections::HashSet::new();
    for footprint in &data.footprints {
        validate_range_footprint_identity(&current, footprint)?;
        if footprint.section_index != current.cursor_index {
            return Err("成功章节足迹必须全部属于当前游标章节".to_string());
        }
        if !block_keys.insert(footprint.block_key.as_str()) {
            return Err("范围阅读足迹正文块不能重复".to_string());
        }
        if !matches!(
            footprint.status.as_str(),
            "filtered" | "silent" | "annotated"
        ) {
            return Err("成功章节足迹只能是 filtered、silent 或 annotated".to_string());
        }
        if footprint.processed_at.is_none() {
            return Err("成功章节足迹必须包含处理时间".to_string());
        }
        if footprint.status == "filtered"
            && (footprint.annotation_id.is_some()
                || footprint.comment.is_some()
                || footprint
                    .reason
                    .as_deref()
                    .is_none_or(|reason| reason.trim().is_empty()))
        {
            return Err("filtered 足迹必须保留非空分类原因且不能关联书评".to_string());
        }
        if footprint.status == "silent" && footprint.annotation_id.is_some() {
            return Err("silent 足迹不能关联书评".to_string());
        }
    }

    let mut note_ids = std::collections::HashSet::new();
    let mut representative_notes = std::collections::HashMap::new();
    for note in &data.notes {
        let quote_is_valid = note.text.as_deref().is_some_and(|text| {
            !text.trim().is_empty()
                && data.footprints.iter().any(|footprint| {
                    footprint.block_key == note.block_key && footprint.text.contains(text)
                })
        });
        if note.id.trim().is_empty()
            || note.block_key.trim().is_empty()
            || note.cfi.trim().is_empty()
            || note.note.trim().is_empty()
            || !block_keys.contains(note.block_key.as_str())
            || note.r#type != "annotation"
            || !quote_is_valid
            || note.style.as_deref() != Some("underline")
            || note.color.as_deref() != Some("blue")
        {
            return Err(
                "范围书评必须是属于本节足迹、带逐字引文、下划线、蓝色和有效 CFI 的 AI 批注"
                    .to_string(),
            );
        }
        if !note_ids.insert(note.id.as_str()) {
            return Err("范围书评 ID 不能重复".to_string());
        }
        representative_notes
            .entry(note.block_key.as_str())
            .or_insert((note.id.as_str(), note.note.as_str()));
    }
    for footprint in &data.footprints {
        match representative_notes.get(footprint.block_key.as_str()) {
            Some((note_id, note_comment))
                if footprint.status == "annotated"
                    && footprint.annotation_id.as_deref() == Some(*note_id)
                    && footprint.comment.as_deref() == Some(*note_comment) => {}
            None if matches!(footprint.status.as_str(), "filtered" | "silent")
                && footprint.annotation_id.is_none() => {}
            _ => return Err("范围足迹终态与代表书评关系不一致".to_string()),
        }
    }

    let now = chrono::Utc::now()
        .timestamp_millis()
        .max(current.updated_at.saturating_add(1));
    let mut persisted_notes = Vec::with_capacity(data.notes.len());
    for note in &data.notes {
        let (context_before, context_after) = range_context_parts(&note.context);
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
        .bind(&current.book_id)
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
        .map_err(|e| format!("创建范围阅读书评失败: {e}"))?;

        let matches_existing: i64 = sqlx::query_scalar(
            r#"
            SELECT COUNT(*) FROM book_notes
            WHERE id=? AND book_id=? AND author='ai' AND source_note_id IS NULL
              AND type=? AND cfi=?
              AND COALESCE(text, '')=COALESCE(?, '')
              AND COALESCE(style, '')=COALESCE(?, '')
              AND COALESCE(color, '')=COALESCE(?, '')
              AND note=?
              AND COALESCE(context_before, '')=COALESCE(?, '')
              AND COALESCE(context_after, '')=COALESCE(?, '')
            "#,
        )
        .bind(&note.id)
        .bind(&current.book_id)
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
        .map_err(|e| format!("校验已有范围阅读书评失败: {e}"))?;
        if matches_existing != 1 {
            return Err("范围书评 ID 与其他内容冲突".to_string());
        }
        let row = sqlx::query("SELECT * FROM book_notes WHERE id=?")
            .bind(&note.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| format!("读取范围阅读书评失败: {e}"))?;
        persisted_notes.push(
            crate::core::books::models::BookNote::from_db_row(&row)
                .map_err(|e| format!("解析范围阅读书评失败: {e}"))?,
        );
    }

    let saved_footprints = upsert_range_footprints_in_tx(&mut tx, &data.footprints, now).await?;
    let settings_update = sqlx::query(
        "UPDATE co_reading_settings SET rolling_summary=?, updated_at=MAX(updated_at + 1, ?) WHERE book_id=?",
    )
    .bind(&data.rolling_summary)
    .bind(now)
    .bind(&current.book_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新范围阅读摘要失败: {e}"))?;
    if settings_update.rows_affected() != 1 {
        return Err("更新范围阅读摘要失败：共读设置不存在".to_string());
    }

    let task_update = sqlx::query(
        r#"
        UPDATE co_reading_range_tasks
        SET cursor_index=?, scanned_count=?, selected_count=?, processed_count=?,
            request_count=?, updated_at=?
        WHERE id=? AND status='running' AND updated_at=?
        "#,
    )
    .bind(data.cursor_index)
    .bind(next_scanned)
    .bind(next_selected)
    .bind(next_processed)
    .bind(next_request_count)
    .bind(now)
    .bind(&current.id)
    .bind(data.expected_updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("更新范围阅读章节进度失败: {e}"))?;
    if task_update.rows_affected() != 1 {
        return Err("范围阅读任务已停止或被其他操作更新".to_string());
    }
    let updated_row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&current.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let task = task_from_row(&updated_row).map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(PersistCoReadingRangeSectionResult {
        task,
        notes: persisted_notes,
        footprints: saved_footprints,
    })
}

pub async fn fail_range_section(
    pool: &SqlitePool,
    data: FailCoReadingRangeSectionData,
) -> Result<FailCoReadingRangeSectionResult, String> {
    if data.task_id.trim().is_empty() {
        return Err("范围阅读任务 ID 不能为空".to_string());
    }
    let error = data.error.trim();
    if error.is_empty() {
        return Err("范围阅读章节失败必须提供非空错误信息".to_string());
    }
    if data.request_delta < 0 {
        return Err("范围阅读请求增量不能为负数".to_string());
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&data.task_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "范围阅读任务不存在".to_string())?;
    let current = task_from_row(&row).map_err(|e| e.to_string())?;
    if current.status != "running" || current.updated_at != data.expected_updated_at {
        return Err("范围阅读任务已停止或被其他操作更新".to_string());
    }
    let next_request_count = current
        .request_count
        .checked_add(data.request_delta)
        .ok_or_else(|| "范围阅读请求计数溢出".to_string())?;
    if next_request_count > current.request_limit {
        return Err("范围阅读请求预算不足".to_string());
    }

    let mut block_keys = std::collections::HashSet::new();
    for footprint in &data.footprints {
        validate_range_footprint_identity(&current, footprint)?;
        if footprint.section_index != current.cursor_index {
            return Err("失败章节足迹必须全部属于当前游标章节".to_string());
        }
        if !block_keys.insert(footprint.block_key.as_str()) {
            return Err("范围阅读足迹正文块不能重复".to_string());
        }
        if !matches!(footprint.status.as_str(), "filtered" | "failed")
            || footprint.annotation_id.is_some()
            || footprint.processed_at.is_none()
            || footprint
                .reason
                .as_deref()
                .is_none_or(|reason| reason.trim().is_empty())
            || (footprint.status == "filtered" && footprint.comment.is_some())
        {
            return Err(
                "失败章节只能写入带非空原因、处理时间且不带书评的 filtered 或 failed 足迹"
                    .to_string(),
            );
        }
    }

    let now = chrono::Utc::now()
        .timestamp_millis()
        .max(current.updated_at.saturating_add(1));
    let saved_footprints = upsert_range_footprints_in_tx(&mut tx, &data.footprints, now).await?;
    let task_update = sqlx::query(
        r#"
        UPDATE co_reading_range_tasks
        SET request_count=?, status='failed', error=?, completed_at=?, updated_at=?
        WHERE id=? AND status='running' AND updated_at=?
        "#,
    )
    .bind(next_request_count)
    .bind(error)
    .bind(now)
    .bind(now)
    .bind(&current.id)
    .bind(data.expected_updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("标记范围阅读章节失败: {e}"))?;
    if task_update.rows_affected() != 1 {
        return Err("范围阅读任务已停止或被其他操作更新".to_string());
    }
    let settings_update = sqlx::query(
        "UPDATE co_reading_settings SET status='paused', updated_at=MAX(updated_at + 1, ?) WHERE book_id=?",
    )
    .bind(now)
    .bind(&current.book_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("暂停范围阅读对应的普通跟读失败: {e}"))?;
    if settings_update.rows_affected() != 1 {
        return Err("暂停范围阅读对应的普通跟读失败：共读设置不存在".to_string());
    }
    let updated_row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&current.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let task = task_from_row(&updated_row).map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(FailCoReadingRangeSectionResult {
        task,
        footprints: saved_footprints,
    })
}

pub async fn advance_task(
    pool: &SqlitePool,
    data: AdvanceCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    if data.task_id.trim().is_empty() {
        return Err("范围阅读任务 ID 不能为空".to_string());
    }
    if data.scanned_delta < 0
        || data.selected_delta < 0
        || data.processed_delta < 0
        || data.request_delta < 0
    {
        return Err("范围阅读进度增量不能为负数".to_string());
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&data.task_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "范围阅读任务不存在".to_string())?;
    let current = task_from_row(&row).map_err(|e| e.to_string())?;
    if current.status != "running" {
        return Err("只有进行中的范围阅读任务可以前进".to_string());
    }
    if data.expected_updated_at != current.updated_at {
        return Err("范围阅读任务已停止或被其他操作更新".to_string());
    }
    let max_cursor = current
        .end_index
        .checked_add(1)
        .ok_or_else(|| "范围阅读结束位置无效".to_string())?;
    if data.cursor_index < current.cursor_index || data.cursor_index > max_cursor {
        return Err("范围阅读游标必须单调且位于当前范围内".to_string());
    }
    let next_request_count = current
        .request_count
        .checked_add(data.request_delta)
        .ok_or_else(|| "范围阅读请求计数溢出".to_string())?;
    if next_request_count > current.request_limit {
        return Err("范围阅读请求预算不足".to_string());
    }
    let next_scanned = current
        .scanned_count
        .checked_add(data.scanned_delta)
        .ok_or_else(|| "范围阅读扫描计数溢出".to_string())?;
    let next_selected = current
        .selected_count
        .checked_add(data.selected_delta)
        .ok_or_else(|| "范围阅读选取计数溢出".to_string())?;
    let next_processed = current
        .processed_count
        .checked_add(data.processed_delta)
        .ok_or_else(|| "范围阅读处理计数溢出".to_string())?;
    let now = chrono::Utc::now()
        .timestamp_millis()
        .max(current.updated_at.saturating_add(1));

    let result = sqlx::query(
        r#"
        UPDATE co_reading_range_tasks
        SET cursor_index=?, scanned_count=?, selected_count=?, processed_count=?,
            request_count=?, updated_at=?
        WHERE id=? AND status='running'
          AND cursor_index=? AND scanned_count=? AND selected_count=?
          AND processed_count=? AND request_count=? AND request_limit=? AND updated_at=?
        "#,
    )
    .bind(data.cursor_index)
    .bind(next_scanned)
    .bind(next_selected)
    .bind(next_processed)
    .bind(next_request_count)
    .bind(now)
    .bind(&data.task_id)
    .bind(current.cursor_index)
    .bind(current.scanned_count)
    .bind(current.selected_count)
    .bind(current.processed_count)
    .bind(current.request_count)
    .bind(current.request_limit)
    .bind(current.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("范围阅读任务已停止或被其他操作更新".to_string());
    }
    let updated_row = sqlx::query("SELECT * FROM co_reading_range_tasks WHERE id=?")
        .bind(&data.task_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let updated = task_from_row(&updated_row).map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(updated)
}

#[tauri::command]
pub async fn create_co_reading_range_task(
    app_handle: AppHandle,
    data: CreateCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    create_task(&app_pool(&app_handle).await?, data).await
}
#[tauri::command]
pub async fn get_co_reading_range_snapshot(
    app_handle: AppHandle,
    book_id: String,
) -> Result<CoReadingRangeSnapshot, String> {
    snapshot(&app_pool(&app_handle).await?, &book_id).await
}
#[tauri::command]
pub async fn update_co_reading_range_task(
    app_handle: AppHandle,
    data: UpdateCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    set_task_status(&app_pool(&app_handle).await?, data).await
}
#[tauri::command]
pub async fn upsert_co_reading_footprints(
    app_handle: AppHandle,
    items: Vec<CoReadingFootprintUpsert>,
) -> Result<Vec<CoReadingFootprint>, String> {
    upsert_footprints(&app_pool(&app_handle).await?, items).await
}
#[tauri::command]
pub async fn advance_co_reading_range_task(
    app_handle: AppHandle,
    data: AdvanceCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    advance_task(&app_pool(&app_handle).await?, data).await
}

#[tauri::command]
pub async fn persist_co_reading_range_section(
    app_handle: AppHandle,
    data: PersistCoReadingRangeSectionData,
) -> Result<PersistCoReadingRangeSectionResult, String> {
    persist_range_section(&app_pool(&app_handle).await?, data).await
}

#[tauri::command]
pub async fn fail_co_reading_range_section(
    app_handle: AppHandle,
    data: FailCoReadingRangeSectionData,
) -> Result<FailCoReadingRangeSectionResult, String> {
    fail_range_section(&app_pool(&app_handle).await?, data).await
}
