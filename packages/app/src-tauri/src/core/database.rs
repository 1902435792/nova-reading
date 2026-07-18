use serde::{Deserialize, Serialize};
use sqlx::{migrate::MigrateDatabase, Sqlite, SqlitePool};
use std::fs;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const RANGE_REQUEST_BUDGET_MIGRATION: &str = "co_reading_range_request_budget_v1";

#[derive(Deserialize, Serialize, Debug)]
struct DefaultSkill {
    name: String,
    content: String,
    description: String,
    is_system: bool,
    is_active: bool,
}

pub async fn initialize(app_handle: &AppHandle) -> Result<SqlitePool, Box<dyn std::error::Error>> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let db_dir = app_data_dir.join("database");
    fs::create_dir_all(&db_dir)?;

    let db_path = db_dir.join("app.db");
    let db_url = format!(
        "sqlite:{}",
        db_path.to_str().ok_or("Invalid database path")?
    );

    if !Sqlite::database_exists(&db_url).await.unwrap_or(false) {
        Sqlite::create_database(&db_url).await?;
        println!("Database created at: {}", db_url);
    } else {
        println!("Database found at: {}", db_url);
    }

    let pool = SqlitePool::connect(&db_url).await?;

    sqlx::query(include_str!("./schema.sql"))
        .execute(&pool)
        .await?;
    println!("Database schema initialized.");

    // 迁移：检查 skills 表是否有 description 列，没有则 ALTER TABLE 添加
    run_migrations(&pool).await?;

    // 每次启动都同步 default-skills.json，按名称 upsert
    sync_default_skills(&pool).await?;

    Ok(pool)
}

/// 运行增量数据库迁移（不破坏已有数据）
pub(crate) async fn run_migrations(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    // 检查 skills.description 列是否存在
    let row = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('skills') WHERE name='description'",
    )
    .fetch_one(pool)
    .await?;

    if row == 0 {
        sqlx::query("ALTER TABLE skills ADD COLUMN description TEXT NOT NULL DEFAULT ''")
            .execute(pool)
            .await?;
        println!("Migration applied: added 'description' column to skills table.");
    }

    let book_note_author = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('book_notes') WHERE name='author'",
    )
    .fetch_one(pool)
    .await?;

    if book_note_author == 0 {
        sqlx::query("ALTER TABLE book_notes ADD COLUMN author TEXT NOT NULL DEFAULT 'human'")
            .execute(pool)
            .await?;
        println!("Migration applied: added 'author' column to book_notes table.");
    }

    let book_note_source = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('book_notes') WHERE name='source_note_id'",
    )
    .fetch_one(pool)
    .await?;
    if book_note_source == 0 {
        sqlx::query("ALTER TABLE book_notes ADD COLUMN source_note_id TEXT")
            .execute(pool)
            .await?;
        println!("Migration applied: added 'source_note_id' column to book_notes table.");
    }
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_book_notes_source_note_id ON book_notes(source_note_id) WHERE source_note_id IS NOT NULL",
    )
    .execute(pool)
    .await?;

    let co_reading_settings_exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='co_reading_settings'",
    )
    .fetch_one(pool)
    .await?;

    if co_reading_settings_exists > 0 {
        let mut added_any = false;
        for column in ["model_provider_id", "model_id"] {
            let exists = sqlx::query_scalar::<_, i64>(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('co_reading_settings') WHERE name='{column}'"
            ))
            .fetch_one(pool)
            .await?;
            if exists == 0 {
                sqlx::query(&format!(
                    "ALTER TABLE co_reading_settings ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                ))
                .execute(pool)
                .await?;
                added_any = true;
            }
        }
        if added_any {
            println!("Migration applied: added co-reading model preference columns.");
        }
    }

    let co_reading_blocks_exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='co_reading_blocks'",
    )
    .fetch_one(pool)
    .await?;
    if co_reading_blocks_exists > 0 {
        let focus_key_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_blocks') WHERE name='focus_key'",
        )
        .fetch_one(pool)
        .await?;
        if focus_key_exists == 0 {
            sqlx::query(
                "ALTER TABLE co_reading_blocks ADD COLUMN focus_key TEXT NOT NULL DEFAULT ''",
            )
            .execute(pool)
            .await?;
            sqlx::query("UPDATE co_reading_blocks SET focus_key=block_key WHERE focus_key='' ")
                .execute(pool)
                .await?;
        }
        sqlx::query("CREATE INDEX IF NOT EXISTS idx_co_reading_blocks_focus ON co_reading_blocks(book_id, focus_key, status, unlocked_at)")
            .execute(pool)
            .await?;
    }

    let range_table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='co_reading_range_tasks'",
    )
    .fetch_one(pool)
    .await?;
    if range_table_exists > 0 {
        for (column, sql_type) in [
            ("start_char_offset", "INTEGER"),
            ("end_char_offset", "INTEGER"),
            ("start_percent", "REAL"),
            ("end_percent", "REAL"),
        ] {
            let exists = sqlx::query_scalar::<_, i64>(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('co_reading_range_tasks') WHERE name='{column}'"
            ))
            .fetch_one(pool)
            .await?;
            if exists == 0 {
                sqlx::query(&format!(
                    "ALTER TABLE co_reading_range_tasks ADD COLUMN {column} {sql_type}"
                ))
                .execute(pool)
                .await?;
            }
        }
        let request_limit_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_range_tasks') WHERE name='request_limit'",
        )
        .fetch_one(pool)
        .await?;
        let status_exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_range_tasks') WHERE name='status'",
        )
        .fetch_one(pool)
        .await?;
        if request_limit_exists > 0 && status_exists > 0 {
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS deepreader_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)",
            )
            .execute(pool)
            .await?;
            let already_repaired: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM deepreader_migrations WHERE name=?")
                    .bind(RANGE_REQUEST_BUDGET_MIGRATION)
                    .fetch_one(pool)
                    .await?;
            if already_repaired == 0 {
                // One-time compatibility repair for unresolved tasks created before retry
                // headroom became part of the fixed budget. CASE branches avoid overflowing
                // SQLite INTEGER arithmetic for malformed legacy extremes.
                let mut tx = pool.begin().await?;
                sqlx::query(
                    r#"
                    UPDATE co_reading_range_tasks
                    SET request_limit = MAX(
                        request_limit,
                        CASE
                            WHEN start_index < 0 OR end_index < start_index THEN request_limit
                            WHEN end_index - start_index > 9223372036854775804 THEN 9223372036854775807
                            ELSE end_index - start_index + 3
                        END,
                        CASE
                            WHEN request_count >= 9223372036854775805 THEN 9223372036854775807
                            WHEN request_count < 0 THEN request_limit
                            ELSE request_count + 2
                        END
                    )
                    WHERE status IN ('running','paused','failed')
                    "#,
                )
                .execute(&mut *tx)
                .await?;
                sqlx::query("INSERT INTO deepreader_migrations (name, applied_at) VALUES (?, ?)")
                    .bind(RANGE_REQUEST_BUDGET_MIGRATION)
                    .bind(chrono::Utc::now().timestamp_millis())
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
            }
        }
    }

    Ok(())
}

/// 将 default-skills.json 中的所有 skill 按名称同步到数据库：
/// - 已存在（按名称匹配）→ 更新 content / description / is_active / is_system
/// - 不存在 → 插入新记录
async fn sync_default_skills(pool: &SqlitePool) -> Result<(), Box<dyn std::error::Error>> {
    let default_skills_json = include_str!("./default-skills.json");
    let default_skills: Vec<DefaultSkill> = serde_json::from_str(default_skills_json)?;

    println!("Syncing {} default skills...", default_skills.len());

    for skill in default_skills {
        let now = chrono::Utc::now().timestamp_millis();

        // 查找是否已存在同名 skill
        let existing = sqlx::query("SELECT id FROM skills WHERE name = ?")
            .bind(&skill.name)
            .fetch_optional(pool)
            .await?;

        if existing.is_some() {
            // 更新已有 skill 的 content、description 和状态
            sqlx::query(
                r#"
                UPDATE skills
                SET content = ?, description = ?, is_active = ?, is_system = ?, updated_at = ?
                WHERE name = ?
                "#,
            )
            .bind(&skill.content)
            .bind(&skill.description)
            .bind(if skill.is_active { 1 } else { 0 })
            .bind(if skill.is_system { 1 } else { 0 })
            .bind(now)
            .bind(&skill.name)
            .execute(pool)
            .await?;
            println!("🔄 Updated skill: {}", skill.name);
        } else {
            // 插入新 skill
            let skill_id = Uuid::new_v4().to_string();
            sqlx::query(
                r#"
                INSERT INTO skills (id, name, content, description, is_active, is_system, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(&skill_id)
            .bind(&skill.name)
            .bind(&skill.content)
            .bind(&skill.description)
            .bind(if skill.is_active { 1 } else { 0 })
            .bind(if skill.is_system { 1 } else { 0 })
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            println!("✅ Inserted skill: {}", skill.name);
        }
    }

    println!("Default skills sync completed.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{run_migrations, RANGE_REQUEST_BUDGET_MIGRATION};
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn migration_adds_book_note_author_without_changing_existing_rows() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create database");
        sqlx::query(
            "CREATE TABLE skills (id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')",
        )
        .execute(&pool)
        .await
        .expect("create skills table");
        sqlx::query("CREATE TABLE book_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create legacy book notes");
        sqlx::query("INSERT INTO book_notes (id, note) VALUES ('old', 'kept')")
            .execute(&pool)
            .await
            .expect("insert legacy book note");

        run_migrations(&pool).await.expect("run migrations");

        let author: String = sqlx::query_scalar("SELECT author FROM book_notes WHERE id = 'old'")
            .fetch_one(&pool)
            .await
            .expect("read migrated row");
        let note: String = sqlx::query_scalar("SELECT note FROM book_notes WHERE id = 'old'")
            .fetch_one(&pool)
            .await
            .expect("read legacy data");
        let source_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('book_notes') WHERE name='source_note_id'",
        )
        .fetch_one(&pool)
        .await
        .expect("read source note column");
        let source: Option<String> =
            sqlx::query_scalar("SELECT source_note_id FROM book_notes WHERE id='old'")
                .fetch_one(&pool)
                .await
                .expect("read migrated source note value");
        assert_eq!(author, "human");
        assert_eq!(note, "kept");
        assert_eq!(source_count, 1);
        assert_eq!(source, None);
    }

    #[tokio::test]
    async fn migration_adds_percentage_range_columns_without_losing_legacy_tasks() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::query(
            "CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL, is_system INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
        )
        .execute(&pool)
        .await
        .expect("create skills table");
        sqlx::query(
            "CREATE TABLE book_notes (id TEXT PRIMARY KEY, note TEXT, author TEXT NOT NULL DEFAULT 'human');",
        )
        .execute(&pool)
        .await
        .expect("create book notes table");
        sqlx::query(
            "CREATE TABLE co_reading_settings (book_id TEXT PRIMARY KEY, status TEXT NOT NULL, dwell_seconds INTEGER NOT NULL, rolling_summary TEXT NOT NULL, model_provider_id TEXT NOT NULL DEFAULT '', model_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
        )
        .execute(&pool)
        .await
        .expect("create settings table");
        sqlx::query(
            "CREATE TABLE co_reading_range_tasks (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, format TEXT NOT NULL, range_kind TEXT NOT NULL, start_index INTEGER NOT NULL, end_index INTEGER NOT NULL, start_label TEXT NOT NULL, end_label TEXT NOT NULL);",
        )
        .execute(&pool)
        .await
        .expect("create legacy range table");
        sqlx::query("INSERT INTO co_reading_range_tasks VALUES ('legacy','book','EPUB','section',1,2,'一','二')")
            .execute(&pool)
            .await
            .expect("insert legacy task");

        run_migrations(&pool).await.expect("run migrations");

        for column in [
            "start_char_offset",
            "end_char_offset",
            "start_percent",
            "end_percent",
        ] {
            let count: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('co_reading_range_tasks') WHERE name='{column}'"
            ))
            .fetch_one(&pool)
            .await
            .expect("read migrated column");
            assert_eq!(count, 1);
        }
        let legacy_id: String = sqlx::query_scalar("SELECT id FROM co_reading_range_tasks")
            .fetch_one(&pool)
            .await
            .expect("legacy task remains");
        assert_eq!(legacy_id, "legacy");
    }

    #[tokio::test]
    async fn migration_adds_co_reading_model_columns_when_table_exists() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create database");
        sqlx::query(
            "CREATE TABLE skills (id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')",
        )
        .execute(&pool)
        .await
        .expect("create skills table");
        sqlx::query("CREATE TABLE book_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'human')")
            .execute(&pool)
            .await
            .expect("create book notes");
        sqlx::query(
            r#"
            CREATE TABLE co_reading_settings (
                book_id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL DEFAULT 'off',
                dwell_seconds INTEGER NOT NULL DEFAULT 15,
                rolling_summary TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("create legacy co reading settings");
        sqlx::query(
            "INSERT INTO co_reading_settings (book_id, status, dwell_seconds, rolling_summary, created_at, updated_at) VALUES ('book', 'off', 15, '', 1, 1)",
        )
        .execute(&pool)
        .await
        .expect("insert legacy settings");

        run_migrations(&pool).await.expect("run migrations");

        let provider_col: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_settings') WHERE name='model_provider_id'",
        )
        .fetch_one(&pool)
        .await
        .expect("provider col");
        let model_col: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_settings') WHERE name='model_id'",
        )
        .fetch_one(&pool)
        .await
        .expect("model col");
        let provider_id: String = sqlx::query_scalar(
            "SELECT model_provider_id FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .expect("provider value");
        assert_eq!(provider_col, 1);
        assert_eq!(model_col, 1);
        assert_eq!(provider_id, "");
    }

    #[tokio::test]
    async fn migration_adds_missing_model_id_when_provider_id_already_exists() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create database");
        sqlx::query(
            "CREATE TABLE skills (id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')",
        )
        .execute(&pool)
        .await
        .expect("create skills table");
        sqlx::query("CREATE TABLE book_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'human')")
            .execute(&pool)
            .await
            .expect("create book notes");
        sqlx::query(
            r#"
            CREATE TABLE co_reading_settings (
                book_id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL DEFAULT 'off',
                dwell_seconds INTEGER NOT NULL DEFAULT 15,
                rolling_summary TEXT NOT NULL DEFAULT '',
                model_provider_id TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .expect("create partially migrated co reading settings");
        sqlx::query(
            "INSERT INTO co_reading_settings (book_id, status, dwell_seconds, rolling_summary, model_provider_id, created_at, updated_at) VALUES ('book', 'off', 15, '', 'provider-1', 1, 1)",
        )
        .execute(&pool)
        .await
        .expect("insert partially migrated settings");

        run_migrations(&pool).await.expect("run migrations");

        let provider_col: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_settings') WHERE name='model_provider_id'",
        )
        .fetch_one(&pool)
        .await
        .expect("provider col");
        let model_col: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('co_reading_settings') WHERE name='model_id'",
        )
        .fetch_one(&pool)
        .await
        .expect("model col");
        let provider_id: String = sqlx::query_scalar(
            "SELECT model_provider_id FROM co_reading_settings WHERE book_id='book'",
        )
        .fetch_one(&pool)
        .await
        .expect("provider value");
        let model_id: String =
            sqlx::query_scalar("SELECT model_id FROM co_reading_settings WHERE book_id='book'")
                .fetch_one(&pool)
                .await
                .expect("model value");
        assert_eq!(provider_col, 1);
        assert_eq!(model_col, 1);
        assert_eq!(provider_id, "provider-1");
        assert_eq!(model_id, "");
    }

    #[tokio::test]
    async fn migration_repairs_unresolved_range_budget_once_without_future_growth() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create database");
        sqlx::query(
            "CREATE TABLE skills (id TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')",
        )
        .execute(&pool)
        .await
        .expect("create skills table");
        sqlx::query(
            "CREATE TABLE book_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'human', source_note_id TEXT)",
        )
        .execute(&pool)
        .await
        .expect("create book notes");
        sqlx::query(
            "CREATE TABLE co_reading_range_tasks (id TEXT PRIMARY KEY, start_index INTEGER NOT NULL, end_index INTEGER NOT NULL, status TEXT NOT NULL, request_limit INTEGER NOT NULL, request_count INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("create legacy range table");
        sqlx::query("INSERT INTO co_reading_range_tasks VALUES ('failed', 2, 5, 'failed', 4, 6)")
            .execute(&pool)
            .await
            .expect("insert legacy failed task");

        run_migrations(&pool).await.expect("run first migration");
        let repaired: (i64, i64) = sqlx::query_as(
            "SELECT request_limit, request_count FROM co_reading_range_tasks WHERE id='failed'",
        )
        .fetch_one(&pool)
        .await
        .expect("read repaired task");
        assert_eq!(repaired.0, 8);
        assert!(repaired.0 >= repaired.1 + 2);

        sqlx::query("UPDATE co_reading_range_tasks SET request_count=7 WHERE id='failed'")
            .execute(&pool)
            .await
            .expect("simulate later retry consumption");
        run_migrations(&pool).await.expect("run migrations again");
        let unchanged_limit: i64 = sqlx::query_scalar(
            "SELECT request_limit FROM co_reading_range_tasks WHERE id='failed'",
        )
        .fetch_one(&pool)
        .await
        .expect("read stable request limit");
        let marker_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM deepreader_migrations WHERE name=?")
                .bind(RANGE_REQUEST_BUDGET_MIGRATION)
                .fetch_one(&pool)
                .await
                .expect("read migration marker");
        assert_eq!(unchanged_limit, repaired.0);
        assert_eq!(marker_count, 1);
    }
}
