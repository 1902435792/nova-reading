pub mod commands;
pub mod models;
pub mod range;

#[cfg(test)]
mod tests {
    use super::commands::{
        claim_blocks, complete_batch, get_snapshot, retry_blocks, update_settings, upsert_blocks,
    };
    use super::models::{
        ClaimCoReadingBlocksData, CoReadingBlockUpsert, CompleteCoReadingBatchData,
        RetryCoReadingBlocksData, UpdateCoReadingSettingsData,
    };
    use sqlx::{sqlite::SqlitePoolOptions, Row};

    async fn create_test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory database");
        sqlx::query(include_str!("../schema.sql"))
            .execute(&pool)
            .await
            .expect("initialize schema");
        pool
    }

    #[tokio::test]
    async fn schema_contains_co_reading_tables_and_book_note_author() {
        let pool = create_test_pool().await;

        let settings_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'co_reading_settings'",
        )
        .fetch_one(&pool)
        .await
        .expect("query settings table");
        let blocks_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'co_reading_blocks'",
        )
        .fetch_one(&pool)
        .await
        .expect("query blocks table");
        let author_column: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('book_notes') WHERE name = 'author'",
        )
        .fetch_one(&pool)
        .await
        .expect("query author column");

        assert_eq!(settings_table, 1);
        assert_eq!(blocks_table, 1);
        assert_eq!(author_column, 1);
    }

    #[tokio::test]
    async fn book_note_author_defaults_to_human() {
        let pool = create_test_pool().await;
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO books (id, title, author, format, file_path, file_size, language, created_at, updated_at) VALUES ('book', 'Book', 'Author', 'EPUB', 'book.epub', 1, 'en', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert book");
        sqlx::query(
            "INSERT INTO book_notes (id, book_id, type, cfi, note, created_at, updated_at) VALUES ('note', 'book', 'annotation', 'epubcfi(/6/2)', '', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert note");

        let row = sqlx::query("SELECT author FROM book_notes WHERE id = 'note'")
            .fetch_one(&pool)
            .await
            .expect("read note author");
        let author: String = row.try_get("author").expect("author column");
        assert_eq!(author, "human");
    }

    async fn insert_book(pool: &sqlx::SqlitePool) {
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO books (id, title, author, format, file_path, file_size, language, created_at, updated_at) VALUES ('book', 'Book', 'Author', 'EPUB', 'book.epub', 1, 'en', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert book");
    }

    fn block(block_key: &str, dwell_ms: i64, status: &str) -> CoReadingBlockUpsert {
        CoReadingBlockUpsert {
            id: format!("id-{block_key}"),
            book_id: "book".to_string(),
            block_key: block_key.to_string(),
            section_index: 1,
            section_label: "Chapter".to_string(),
            cfi: format!("epubcfi(/6/2[{block_key}])"),
            text: format!("Text for {block_key}"),
            text_hash: format!("hash-{block_key}"),
            dwell_ms,
            status: status.to_string(),
            unlocked_at: (status == "queued").then_some(100),
        }
    }

    #[tokio::test]
    async fn settings_validate_status_and_dwell_range() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;

        let invalid_status = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "running".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await;
        assert!(invalid_status.is_err());

        let invalid_dwell = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 4,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await;
        assert!(invalid_dwell.is_err());

        let settings = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 20,
                rolling_summary: Some("read summary".to_string()),
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("update valid settings");
        assert_eq!(settings.status, "active");
        assert_eq!(settings.dwell_seconds, 20);
    }

    #[tokio::test]
    async fn block_upsert_is_idempotent_and_preserves_terminal_state() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;

        upsert_blocks(&pool, vec![block("a", 1_000, "tracking")])
            .await
            .expect("insert tracking block");
        upsert_blocks(&pool, vec![block("a", 15_000, "queued")])
            .await
            .expect("queue block");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim block");
        complete_batch(
            &pool,
            CompleteCoReadingBatchData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
                status: "silent".to_string(),
                decision: Some("silent".to_string()),
                annotation_id: None,
                annotated_block_key: None,
                error: None,
                rolling_summary: Some("summary".to_string()),
            },
        )
        .await
        .expect("complete block");

        upsert_blocks(&pool, vec![block("a", 30_000, "queued")])
            .await
            .expect("repeat upsert");
        let snapshot = get_snapshot(&pool, "book", 0).await.expect("get snapshot");
        assert_eq!(snapshot.blocks.len(), 1);
        assert_eq!(snapshot.blocks[0].status, "silent");
        assert_eq!(snapshot.blocks[0].dwell_ms, 30_000);
        assert_eq!(snapshot.settings.rolling_summary, "summary");
    }

    #[tokio::test]
    async fn failed_blocks_require_retry_before_they_return_to_queue() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        upsert_blocks(&pool, vec![block("a", 15_000, "queued")])
            .await
            .expect("queue block");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim block");
        complete_batch(
            &pool,
            CompleteCoReadingBatchData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
                status: "failed".to_string(),
                decision: None,
                annotation_id: None,
                annotated_block_key: None,
                error: Some("model failed".to_string()),
                rolling_summary: None,
            },
        )
        .await
        .expect("fail block");

        retry_blocks(
            &pool,
            RetryCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("retry block");
        let snapshot = get_snapshot(&pool, "book", 0).await.expect("get snapshot");
        assert_eq!(snapshot.blocks[0].status, "queued");
        assert!(snapshot.blocks[0].error.is_none());
    }

    #[tokio::test]
    async fn annotated_batch_marks_only_the_selected_block_as_annotated() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        upsert_blocks(
            &pool,
            vec![block("a", 15_000, "queued"), block("b", 15_000, "queued")],
        )
        .await
        .expect("queue blocks");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
            },
        )
        .await
        .expect("claim blocks");
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query("INSERT INTO book_notes (id, book_id, type, cfi, author, note, created_at, updated_at) VALUES ('note', 'book', 'annotation', 'epubcfi(/6/2)', 'ai', '', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .expect("insert annotation");

        complete_batch(
            &pool,
            CompleteCoReadingBatchData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string(), "b".to_string()],
                status: "annotated".to_string(),
                decision: Some("annotate".to_string()),
                annotation_id: Some("note".to_string()),
                annotated_block_key: Some("b".to_string()),
                error: None,
                rolling_summary: None,
            },
        )
        .await
        .expect("complete annotated batch");

        let snapshot = get_snapshot(&pool, "book", 0).await.expect("get snapshot");
        let a = snapshot
            .blocks
            .iter()
            .find(|item| item.block_key == "a")
            .unwrap();
        let b = snapshot
            .blocks
            .iter()
            .find(|item| item.block_key == "b")
            .unwrap();
        assert_eq!(a.status, "silent");
        assert!(a.annotation_id.is_none());
        assert_eq!(b.status, "annotated");
        assert_eq!(b.annotation_id.as_deref(), Some("note"));
    }

    #[tokio::test]
    async fn snapshot_recovers_stale_processing_blocks_to_queue() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;
        upsert_blocks(&pool, vec![block("a", 15_000, "queued")])
            .await
            .expect("queue block");
        claim_blocks(
            &pool,
            ClaimCoReadingBlocksData {
                book_id: "book".to_string(),
                block_keys: vec!["a".to_string()],
            },
        )
        .await
        .expect("claim block");
        sqlx::query("UPDATE co_reading_blocks SET updated_at = 1 WHERE block_key = 'a'")
            .execute(&pool)
            .await
            .expect("age processing block");

        let snapshot = get_snapshot(&pool, "book", 1_000)
            .await
            .expect("get snapshot");
        assert_eq!(snapshot.blocks[0].status, "queued");
        assert_eq!(snapshot.stats.queued, 1);
        assert_eq!(snapshot.stats.processing, 0);
    }

    #[tokio::test]
    async fn settings_persist_book_model_preference_without_credentials() {
        let pool = create_test_pool().await;
        insert_book(&pool).await;

        let settings = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: Some("openai".to_string()),
                model_id: Some("gpt-4o-mini".to_string()),
            },
        )
        .await
        .expect("set book model");
        assert_eq!(settings.model_provider_id, "openai");
        assert_eq!(settings.model_id, "gpt-4o-mini");

        let kept = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "paused".to_string(),
                dwell_seconds: 30,
                rolling_summary: None,
                model_provider_id: None,
                model_id: None,
            },
        )
        .await
        .expect("update status only");
        assert_eq!(kept.status, "paused");
        assert_eq!(kept.dwell_seconds, 30);
        assert_eq!(kept.model_provider_id, "openai");
        assert_eq!(kept.model_id, "gpt-4o-mini");

        let cleared = update_settings(
            &pool,
            UpdateCoReadingSettingsData {
                book_id: "book".to_string(),
                status: "active".to_string(),
                dwell_seconds: 15,
                rolling_summary: None,
                model_provider_id: Some(String::new()),
                model_id: Some(String::new()),
            },
        )
        .await
        .expect("clear book model");
        assert_eq!(cleared.model_provider_id, "");
        assert_eq!(cleared.model_id, "");
    }
}
