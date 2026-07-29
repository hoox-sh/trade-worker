-- workers/trade-worker/schema.sql
--
-- ⚠️  IDEMPOTENT SCHEMA
-- Uses CREATE TABLE IF NOT EXISTS so running `hoox setup` again will NOT
-- wipe existing data. If you need to reset during development, run:
--   for table in trade_signals trades positions balances system_logs; do
--     wrangler d1 execute trade-data-db --command="DROP TABLE IF EXISTS $table;" --remote
--   done
--   wrangler d1 execute trade-data-db --file workers/trade-worker/schema.sql --remote

-- 1. Incoming Signals Tracker
CREATE TABLE IF NOT EXISTS trade_signals (
    signal_id TEXT PRIMARY KEY,      -- Unique identifier for the signal (e.g., UUID)
    timestamp INTEGER NOT NULL,      -- Unix timestamp (seconds) of when the signal was generated/received
    symbol TEXT NOT NULL,            -- Trading symbol (e.g., 'BTCUSDT')
    signal_type TEXT NOT NULL,       -- Type of signal (e.g., 'BUY', 'SELL', 'HOLD', 'LONG', 'SHORT')
    source TEXT,                     -- Source of the signal (e.g., 'TradingView', 'Email')
    raw_data TEXT,                   -- Store the original raw signal data (e.g., JSON string)
    processed_at INTEGER DEFAULT (unixepoch()) -- Timestamp when the record was inserted
);

CREATE INDEX IF NOT EXISTS idx_trade_signals_timestamp ON trade_signals (timestamp);
CREATE INDEX IF NOT EXISTS idx_trade_signals_symbol ON trade_signals (symbol);

-- 2. Executed Trades
CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,             -- Unique identifier for the trade
    signal_id TEXT,                  -- Optional link to the originating signal
    timestamp INTEGER NOT NULL,      -- Unix timestamp
    exchange TEXT NOT NULL,          -- Exchange name (e.g., 'mexc', 'binance')
    symbol TEXT NOT NULL,            -- Trading symbol
    action TEXT NOT NULL,            -- Action (e.g., 'LONG', 'SHORT', 'CLOSE_LONG')
    quantity REAL,                   -- Size of the trade
    price REAL,                      -- Execution price
    leverage INTEGER,                -- Leverage used
    status TEXT NOT NULL,            -- Status ('EXECUTED', 'TEST_EXECUTED', 'FAILED', 'PENDING')
    error_message TEXT,              -- Any error message if failed
    raw_response TEXT,               -- JSON response from the exchange
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades (timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);

-- 3. Active & Closed Positions
CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,             -- Unique ID, can be derived from exchange+symbol
    exchange TEXT NOT NULL,          
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,              -- 'LONG' or 'SHORT'
    entry_price REAL,
    mark_price REAL,
    liquidation_price REAL,
    leverage INTEGER,
    size REAL,
    unrealized_pnl REAL,
    status TEXT NOT NULL,            -- 'OPEN' or 'CLOSED'
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions (symbol);

-- 4. Exchange Balances Snapshots
CREATE TABLE IF NOT EXISTS balances (
    id TEXT PRIMARY KEY,
    exchange TEXT NOT NULL,
    asset TEXT NOT NULL,             -- e.g., 'USDT'
    free REAL,
    used REAL,
    total REAL,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_balances_timestamp ON balances (timestamp);

-- 5. System Observability Logs
CREATE TABLE IF NOT EXISTS system_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER DEFAULT (unixepoch()),
    level TEXT NOT NULL,             -- 'INFO', 'WARN', 'ERROR', 'DEBUG'
    service TEXT NOT NULL,           -- Worker name (e.g., 'hoox', 'trade-worker')
    message TEXT NOT NULL,
    details TEXT                     -- JSON string for extra context
);

CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs (level);
CREATE INDEX IF NOT EXISTS idx_system_logs_service ON system_logs (service);
