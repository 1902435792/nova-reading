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
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM co_reading_range_tasks WHERE book_id=? AND status IN ('running','paused')")
        .bind(&data.book_id).fetch_one(pool).await.map_err(|e| e.to_string())?;
    if active > 0 {
        return Err("本书已有未结束的范围阅读任务".into());
    }
    let previous: Option<String> =
        sqlx::query_scalar("SELECT status FROM co_reading_settings WHERE book_id=?")
            .bind(&data.book_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let previous_status = previous.unwrap_or_else(|| "off".into());
    sqlx::query("INSERT INTO co_reading_range_tasks (id,book_id,format,range_kind,start_index,end_index,start_label,end_label,start_char_offset,end_char_offset,start_percent,end_percent,status,previous_follow_status,cursor_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'running',?,?,?,?)")
        .bind(&id).bind(&data.book_id).bind(&data.format).bind(&data.range_kind).bind(data.start_index).bind(data.end_index)
        .bind(&data.start_label).bind(&data.end_label).bind(data.start_char_offset).bind(data.end_char_offset)
        .bind(data.start_percent).bind(data.end_percent).bind(&previous_status).bind(data.start_index).bind(now).bind(now)
        .execute(pool).await.map_err(|e| format!("创建范围阅读任务失败: {e}"))?;
    if previous_status == "active" {
        sqlx::query("UPDATE co_reading_settings SET status='paused', updated_at=? WHERE book_id=?")
            .bind(now)
            .bind(&data.book_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    get_task(pool, &id).await
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
    let now = chrono::Utc::now().timestamp_millis();
    let completed =
        matches!(data.status.as_str(), "completed" | "stopped" | "failed").then_some(now);
    let result = sqlx::query("UPDATE co_reading_range_tasks SET status=?, error=?, completed_at=?, updated_at=? WHERE id=?")
        .bind(&data.status).bind(&data.error).bind(completed).bind(now).bind(&data.task_id).execute(pool).await.map_err(|e| e.to_string())?;
    if result.rows_affected() != 1 {
        return Err("范围阅读任务不存在".into());
    }
    let task = get_task(pool, &data.task_id).await?;
    if completed.is_some() && task.previous_follow_status == "active" {
        sqlx::query("UPDATE co_reading_settings SET status='active', updated_at=? WHERE book_id=?")
            .bind(now)
            .bind(&task.book_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(task)
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

pub async fn advance_task(
    pool: &SqlitePool,
    data: AdvanceCoReadingRangeTaskData,
) -> Result<CoReadingRangeTask, String> {
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query("UPDATE co_reading_range_tasks SET cursor_index=?,scanned_count=scanned_count+?,selected_count=selected_count+?,processed_count=processed_count+?,request_count=request_count+?,updated_at=? WHERE id=? AND status='running'")
        .bind(data.cursor_index).bind(data.scanned_delta).bind(data.selected_delta).bind(data.processed_delta).bind(data.request_delta).bind(now).bind(&data.task_id)
        .execute(pool).await.map_err(|e|e.to_string())?;
    get_task(pool, &data.task_id).await
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
