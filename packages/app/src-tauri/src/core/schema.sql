CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT,
    metadata TEXT NOT NULL,
    title TEXT NOT NULL,
    messages TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    format TEXT NOT NULL,
    file_path TEXT NOT NULL,
    cover_path TEXT,
    
    file_size INTEGER NOT NULL,
    language TEXT NOT NULL,
    
    tags TEXT,
    
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_status (
    book_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread',  -- 'unread', 'reading', 'completed'
    progress_current INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0,
    location TEXT,                           -- CFI 位置信息
    last_read_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    metadata TEXT,                 -- JSON 存储其他信息（设置、偏好等）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- 阅读会话表 - 记录每次详细的阅读会话
CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,            -- 开始阅读时间戳
    ended_at INTEGER,                       -- 结束阅读时间戳（null表示未结束）
    duration_seconds INTEGER DEFAULT 0,     -- 实际阅读时长（秒）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);



CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_updated_at ON books(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_book_status_status ON book_status(status);
CREATE INDEX IF NOT EXISTS idx_book_status_progress ON book_status(progress_current, progress_total);
CREATE INDEX IF NOT EXISTS idx_book_status_location ON book_status(location);
CREATE INDEX IF NOT EXISTS idx_book_status_last_read ON book_status(last_read_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_status_updated_at ON book_status(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_book_id ON threads(book_id);

-- reading_sessions 表的索引
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON reading_sessions(book_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_started_at ON reading_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_date ON reading_sessions(DATE(started_at/1000, 'unixepoch'));
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_date ON reading_sessions(book_id, DATE(started_at/1000, 'unixepoch'));

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_tags_updated_at ON tags(updated_at DESC);

-- 笔记表
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT,                           -- 可选关联的书籍ID
    book_meta TEXT,                         -- JSON 存储书籍信息（title, author）
    title TEXT,                             -- 笔记标题（可选）
    content TEXT,                           -- 笔记内容（可选，支持markdown）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL
);

-- notes 表的索引
CREATE INDEX IF NOT EXISTS idx_notes_book_id ON notes(book_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);

-- BookNote 表 - 存储书籍标注、书签、摘录等
CREATE TABLE IF NOT EXISTS book_notes (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    type TEXT NOT NULL,                    -- 笔记类型: bookmark|annotation|excerpt
    cfi TEXT NOT NULL,                     -- 位置信息 (CFI格式)
    text TEXT,                             -- 选中的文本内容
    style TEXT,                            -- 高亮样式: highlight|underline|squiggly
    color TEXT,                            -- 颜色: red|yellow|green|blue|violet
    author TEXT NOT NULL DEFAULT 'human',  -- 标注作者: human|ai
    note TEXT NOT NULL,                    -- 用户笔记内容
    context_before TEXT,                   -- 前文上下文
    context_after TEXT,                    -- 后文上下文
    created_at INTEGER NOT NULL,           -- 创建时间戳
    updated_at INTEGER NOT NULL,           -- 更新时间戳
    
    -- 外键约束
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- book_notes 表的索引
CREATE INDEX IF NOT EXISTS idx_book_notes_book_id ON book_notes(book_id);
CREATE INDEX IF NOT EXISTS idx_book_notes_type ON book_notes(type);
CREATE INDEX IF NOT EXISTS idx_book_notes_created_at ON book_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_notes_cfi ON book_notes(cfi);

-- AI 共读设置 - 每本书独立控制
CREATE TABLE IF NOT EXISTS co_reading_settings (
    book_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'off' CHECK (status IN ('off', 'active', 'paused')),
    dwell_seconds INTEGER NOT NULL DEFAULT 15 CHECK (dwell_seconds BETWEEN 5 AND 60),
    rolling_summary TEXT NOT NULL DEFAULT '',
    model_provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- AI 共读文本块账本 - 记录停留、解锁和处理终态
CREATE TABLE IF NOT EXISTS co_reading_blocks (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    block_key TEXT NOT NULL,
    section_index INTEGER NOT NULL,
    section_label TEXT NOT NULL DEFAULT '',
    cfi TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    dwell_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'tracking' CHECK (status IN ('tracking', 'queued', 'processing', 'silent', 'annotated', 'failed')),
    decision TEXT,
    annotation_id TEXT,
    error TEXT,
    unlocked_at INTEGER,
    processed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (annotation_id) REFERENCES book_notes(id) ON DELETE SET NULL,
    UNIQUE (book_id, block_key)
);

CREATE INDEX IF NOT EXISTS idx_co_reading_blocks_book_status
    ON co_reading_blocks(book_id, status, unlocked_at);
CREATE INDEX IF NOT EXISTS idx_co_reading_blocks_updated_at
    ON co_reading_blocks(updated_at);

-- Nova 自主范围阅读任务
CREATE TABLE IF NOT EXISTS co_reading_range_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    book_id TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('EPUB', 'PDF')),
    range_kind TEXT NOT NULL CHECK (range_kind IN ('section', 'page')),
    start_index INTEGER NOT NULL,
    end_index INTEGER NOT NULL,
    start_label TEXT NOT NULL DEFAULT '',
    end_label TEXT NOT NULL DEFAULT '',
    start_char_offset INTEGER,
    end_char_offset INTEGER,
    start_percent REAL,
    end_percent REAL,
    status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'stopped', 'failed')),
    previous_follow_status TEXT NOT NULL DEFAULT 'off' CHECK (previous_follow_status IN ('off', 'active', 'paused')),
    candidate_limit INTEGER NOT NULL DEFAULT 40,
    per_section_limit INTEGER NOT NULL DEFAULT 6,
    request_limit INTEGER NOT NULL DEFAULT 8,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    selected_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    cursor_index INTEGER NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_co_reading_range_tasks_book_status
    ON co_reading_range_tasks(book_id, status, updated_at DESC);

-- Nova 阅读地图足迹；任务历史独立于普通跟读账本
CREATE TABLE IF NOT EXISTS co_reading_footprints (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    block_key TEXT NOT NULL,
    section_index INTEGER NOT NULL,
    section_label TEXT NOT NULL DEFAULT '',
    cfi TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('filtered', 'candidate', 'selected', 'silent', 'annotated', 'failed')),
    reason TEXT,
    summary TEXT,
    comment TEXT,
    annotation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    processed_at INTEGER,
    FOREIGN KEY (task_id) REFERENCES co_reading_range_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (annotation_id) REFERENCES book_notes(id) ON DELETE SET NULL,
    UNIQUE (task_id, block_key)
);

CREATE INDEX IF NOT EXISTS idx_co_reading_footprints_book_section
    ON co_reading_footprints(book_id, section_index, updated_at);
CREATE INDEX IF NOT EXISTS idx_co_reading_footprints_task_status
    ON co_reading_footprints(task_id, status, section_index);
CREATE INDEX IF NOT EXISTS idx_co_reading_footprints_annotation
    ON co_reading_footprints(annotation_id);

-- 技能库表 - 存储 AI 技能的标准操作流程
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,             -- 技能名称（如：生成思维导图）
    content TEXT NOT NULL,                 -- 技能内容（Markdown 格式的完整说明）
    description TEXT NOT NULL DEFAULT '',  -- 技能简述（1-2 句话，注入提示词用于触发判断）
    is_active INTEGER DEFAULT 1,           -- 是否启用（1=启用，0=禁用）
    is_system INTEGER DEFAULT 0,           -- 是否为系统技能（1=系统，0=用户，系统技能不可删除）
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- skills 表的索引
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_is_active ON skills(is_active);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at DESC);

-- 用户记忆表 - Agent 跨 session 的持久化语义记忆
CREATE TABLE IF NOT EXISTS user_memories (
    id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL,           -- user_profile | book_gist | concept
    key TEXT NOT NULL,                -- 语义键 ("explanation_style", "GEB-core-thesis")
    value TEXT NOT NULL,              -- 自然语言描述
    source_type TEXT,                 -- conversation | annotation | auto_extract | manual
    source_id TEXT,                   -- thread_id / book_note_id
    book_id TEXT,                     -- concept/book_gist 关联书籍
    related_memory_ids TEXT,          -- JSON 数组：关联的其他记忆 ID
    confidence REAL DEFAULT 1.0,      -- 置信度 0-1
    access_count INTEGER DEFAULT 0,   -- 被注入 prompt 的次数
    last_accessed_at INTEGER,         -- 上次注入时间
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE SET NULL
);

-- user_memories 表的索引
CREATE INDEX IF NOT EXISTS idx_memories_category ON user_memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_book_id ON user_memories(book_id);
CREATE INDEX IF NOT EXISTS idx_memories_key ON user_memories(key);
CREATE INDEX IF NOT EXISTS idx_memories_access ON user_memories(access_count DESC);
