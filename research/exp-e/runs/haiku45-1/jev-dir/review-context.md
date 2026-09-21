# Contexto de review (gerado pelo jev-enhancer)

## Diff em revisão
```diff
diff --git a/packages/api-go/cmd/server/main.go b/packages/api-go/cmd/server/main.go
index 2312fae..a75ca15 100644
--- a/packages/api-go/cmd/server/main.go
+++ b/packages/api-go/cmd/server/main.go
@@ -17,6 +17,7 @@ import (
 	"pdv/api-go/internal/auth"
 	"pdv/api-go/internal/config"
 	"pdv/api-go/internal/db"
+	"pdv/api-go/internal/fiado"
 	"pdv/api-go/internal/handler"
 	"pdv/api-go/internal/httpx"
 	apimw "pdv/api-go/internal/middleware"
@@ -153,9 +154,15 @@ func main() {
 			Tokens:   tokenIssuer,
 			Provider: nfe.NewMockProvider(),
 		})
+		handler.MountFiado(router, handler.FiadoDeps{
+			Users:   queries,
+			Tokens:  tokenIssuer,
+			Pending: fiado.NewPendingService(queries),
+		})
 		logger.Info("auth routes mounted", "prefix", "/auth")
 		logger.Info("sync routes mounted", "prefix", "/sync")
 		logger.Info("notas routes mounted", "prefixes", "/notas,/invoices", "provider", "mock")
+		logger.Info("fiado routes mounted", "prefix", "/api/v1/customers")
 	} else {
 		logger.Warn("auth routes disabled without DATABASE_URL")
 	}
diff --git a/packages/api-go/internal/middleware/apikey_test.go b/packages/api-go/internal/middleware/apikey_test.go
index 1ab61cf..db6283c 100644
--- a/packages/api-go/internal/middleware/apikey_test.go
+++ b/packages/api-go/internal/middleware/apikey_test.go
@@ -84,6 +84,23 @@ func TestAPIKey(t *testing.T) {
 			path:       "/sync/initial",
 			wantStatus: http.StatusUnauthorized,
 		},
+		{
+			name:   "fiado with bearer skips API key",
+			cfg:    &config.Config{APIKey: secret},
+			method: http.MethodGet,
+			path:   "/api/v1/customers/42/fiado",
+			headers: map[string]string{
+				"Authorization": "Bearer token_1_123",
+			},
+			wantStatus: http.StatusOK,
+		},
+		{
+			name:       "fiado without bearer requires API key",
+			cfg:        &config.Config{APIKey: secret},
+			method:     http.MethodGet,
+			path:       "/api/v1/customers/42/fiado",
+			wantStatus: http.StatusUnauthorized,
+		},
 	}
 
 	for _, tc := range tests {
diff --git a/packages/api-go/internal/middleware/routes.go b/packages/api-go/internal/middleware/routes.go
index 541131f..4bb6a6a 100644
--- a/packages/api-go/internal/middleware/routes.go
+++ b/packages/api-go/internal/middleware/routes.go
@@ -19,6 +19,7 @@ var (
 		"/invoices/",
 		"/notas/",
 		"/auth/me",
+		"/api/v1/customers/",
 	}
 )
 

diff --git a/AGENTS.md b/AGENTS.md
--- /dev/null
+++ b/AGENTS.md
@@ -0,0 +1,115 @@
+# AGENTS.md
+
+Guidance for AI agents working in this repository.
+
+## Project Overview
+
+This is a PDV monorepo for a point-of-sale system.
+
+- `packages/desktop`: Tauri 2 desktop app with React, TypeScript, Vite, Rust, and local SQLite.
+- `packages/api-go`: Cloud API in Go with Chi, pgx, sqlc, goose migrations, PostgreSQL, JWT auth, sync endpoints, and mock NF-e provider.
+- Root `package.json`: npm workspace entrypoint for the desktop package plus helper scripts for API and build commands.
+
+The business domain is Brazilian POS terminology. Preserve existing names such as PDV, PAF, NFC-e, fiado, notas, and sync unless the task explicitly asks for a rename.
+
+## Repository Layout
+
+- `README.md`: high-level setup and commands.
+- `packages/desktop/src`: React UI, routes, contexts, services, utilities, and CSS.
+- `packages/desktop/src-tauri/src`: Rust/Tauri backend, commands, SQLite repositories, services, printer, sync, PAF, and models.
+- `packages/desktop/src-tauri/src/database`: SQLite connection and migrations used by the desktop app.
+- `packages/api-go/cmd/server`: Go API entrypoint.
+- `packages/api-go/internal`: Go application packages. Keep private app code here; do not add `pkg/` for private code.
+- `packages/api-go/query`: source SQL queries for sqlc.
+- `packages/api-go/db/schema.sql`: source schema used by sqlc.
+- `packages/api-go/internal/db`: generated sqlc Go code. Do not edit by hand.
+- `packages/api-go/migrations`: goose PostgreSQL migrations.
+
+## Required Tooling
+
+- Node.js `>=20` and npm `>=9`.
+- Go as declared in `packages/api-go/go.mod`.
+- Rust stable for Tauri builds.
+- PostgreSQL for API integration tests and local API development.
+- Docker/Compose is optional for the API local stack.
+
+## Common Commands
+
+Run commands from the repository root unless noted.
+
+- Install dependencies: `npm install`
+- Start Vite desktop frontend: `npm run dev`
+- Start Tauri desktop app: `npm run dev:desktop:tauri`
+- Build desktop frontend: `npm run build`
+- Build Tauri desktop app: `npm run build:desktop:tauri`
+- Typecheck workspaces: `npm run typecheck`
+- Start Go API: `npm run dev:api`
+- Build Go API: `make -C packages/api-go build`
+- Run Go tests: `make -C packages/api-go test`
+- Run Go integration tests: set `TEST_DATABASE_URL` or `DATABASE_URL`, then `make -C packages/api-go test-integration`
+- Generate sqlc code: `make -C packages/api-go sqlc`
+- Run migrations: set `DATABASE_URL`, then `make -C packages/api-go migrate-up`
+- Start API Docker stack: copy `packages/api-go/.env.example` to `packages/api-go/.env`, adjust values, then `make -C packages/api-go docker-up`
+- Stop API Docker stack: `make -C packages/api-go docker-down`
+
+For Rust-only checks in the desktop backend, run from `packages/desktop`: `cargo check` or `cargo test`.
+
+## Environment
+
+- API env example: `packages/api-go/.env.example`.
+- Desktop env values must use Vite prefixes, for example `VITE_API_URL` or the existing `VITE_API_BASE_URL` usage.
+- Never commit real `.env` files, tokens, keys, API credentials, database dumps, or customer fiscal data.
+- The Go API reads configuration from environment variables; the Makefile only exports `packages/api-go/.env` for targets run from that directory.
+
+## Go API Guidelines
+
+- Follow `.cursor/rules/RULES.md` for Go conventions in this repository.
+- Prefer standard library packages before adding dependencies, especially `net/http`, `context`, and `log/slog`.
+- Functions that perform or may perform network I/O should accept `context.Context` as the first parameter named `ctx`.
+- Return errors from lower layers and log at process or handler boundaries.
+- Wrap inspectable errors with `%w`.
+- Use table-driven tests for pure logic and `httptest` for HTTP behavior.
+- Keep SQL source in `packages/api-go/query` and `packages/api-go/db/schema.sql`, then regenerate `internal/db` with `make -C packages/api-go sqlc`.
+- Do not manually edit generated files under `packages/api-go/internal/db`.
+- For database changes, update both the goose migration path and sqlc schema/query sources when needed.
+
+## Desktop Guidelines
+
+- React code lives in `packages/desktop/src`; Tauri Rust code lives in `packages/desktop/src-tauri/src`.
+- Keep TypeScript strict-clean. The desktop build runs `tsc && vite build`.
+- Frontend calls into Tauri commands through `@tauri-apps/api/core` `invoke` wrappers in `src/services`.
+- When adding or renaming a Tauri command, update both the Rust command registration and the TypeScript service wrapper/types.
+- Preserve existing UI structure and Portuguese user-facing copy unless asked otherwise.
+- SQLite schema and data behavior for the desktop app belong in the Rust database/repository/service layers, not directly in React components.
+- Do not introduce browser-only APIs in code that must run inside the Tauri backend.
+
+## Testing And Verification
+
+Choose the narrowest verification that covers the change.
+
+- Frontend TypeScript/UI change: `npm run build:desktop` or `npm run typecheck`.
+- Tauri/Rust backend change: run `cargo check` from `packages/desktop`; use `cargo test` when tests exist or behavior is covered.
+- Go API pure/backend change: `make -C packages/api-go test`.
+- Go DB/query/migration change: run `make -C packages/api-go sqlc`, then `make -C packages/api-go test`; use integration tests when database behavior changed.
+- Root scripts/package changes: run the affected `npm run ...` command from root.
+
+If a command cannot run because required services or env vars are missing, report that clearly with the exact missing prerequisite.
+
+## Dependency Policy
+
+- Keep changes minimal and use existing libraries/patterns first.
+- Add third-party modules only when there is a clear benefit; mention the reason in the final response or PR description.
+- Keep `package-lock.json`, `go.sum`, and Cargo lockfiles consistent with manifest changes.
+
+## Generated And Build Artifacts
+
+- Do not edit generated sqlc files in `packages/api-go/internal/db` manually.
+- Do not commit `node_modules`, local database files, build output, or `.env` files.
+- Before changing ignored/local files, verify they are intentionally part of the task.
+
+## Collaboration Rules
+
+- Do not revert user changes unless explicitly asked.
+- Prefer small, targeted changes over broad rewrites.
+- Update documentation when commands, env vars, package layout, or setup behavior changes.
+- Keep final responses concise and include what changed plus what verification was run.

diff --git a/packages/api-go/internal/db/fiado_integration_test.go b/packages/api-go/internal/db/fiado_integration_test.go
--- /dev/null
+++ b/packages/api-go/internal/db/fiado_integration_test.go
@@ -0,0 +1,215 @@
+package db_test
+
+import (
+	"context"
+	"errors"
+	"fmt"
+	"testing"
+	"time"
+
+	"github.com/jackc/pgx/v5"
+	"github.com/jackc/pgx/v5/pgtype"
+
+	"pdv/api-go/internal/db"
+	"pdv/api-go/internal/testutil"
+)
+
+// numericFloat reads a pgtype.Numeric as float64; amounts here have 2 decimals,
+// so exact float comparison is safe.
+func numericFloat(t *testing.T, n pgtype.Numeric) float64 {
+	t.Helper()
+	f, err := n.Float64Value()
+	if err != nil {
+		t.Fatalf("Float64Value: %v", err)
+	}
+	if !f.Valid {
+		t.Fatal("numeric is NULL, want a value")
+	}
+	return f.Float64
+}
+
+func TestPendingFiadoQueries(t *testing.T) {
+	pool, queries, cleanup := testutil.OpenDB(t)
+	defer cleanup()
+
+	ctx := context.Background()
+
+	suffix := time.Now().UnixNano() % 1_000_000_000_000
+	var userID, otherUserID int32
+	err := pool.QueryRow(ctx, `
+		INSERT INTO users (login, name, password, cnpj, razao_social, uf)
+		VALUES ($1, 'Test Fiado', 'hash', $2, 'Test LTDA', 'SC')
+		RETURNING id`,
+		fmt.Sprintf("test_fiado_%d", suffix), fmt.Sprintf("%014d", suffix+1)).Scan(&userID)
+	if err != nil {
+		t.Fatalf("seed user: %v", err)
+	}
+	err = pool.QueryRow(ctx, `
+		INSERT INTO users (login, name, password, cnpj, razao_social, uf)
+		VALUES ($1, 'Outro', 'hash', $2, 'Outro LTDA', 'SC')
+		RETURNING id`,
+		fmt.Sprintf("test_fiado_other_%d", suffix), fmt.Sprintf("%014d", suffix+2)).Scan(&otherUserID)
+	if err != nil {
+		t.Fatalf("seed other user: %v", err)
+	}
+
+	var customerID int32
+	if err := pool.QueryRow(ctx, `
+		INSERT INTO customers (user_id, name) VALUES ($1, 'Cliente Fiado') RETURNING id`,
+		userID).Scan(&customerID); err != nil {
+		t.Fatalf("seed customer: %v", err)
+	}
+
+	var productID int32
+	if err := pool.QueryRow(ctx, `
+		INSERT INTO products (user_id, code, name, price) VALUES ($1, 'P-FIADO', 'Produto', 10.00)
+		RETURNING id`, userID).Scan(&productID); err != nil {
+		t.Fatalf("seed product: %v", err)
+	}
+
+	// Seeded sales, newest first: only "aberta" and "parcial" are open fiado.
+	seedSale := func(name string, daysAgo int, total string, isCredit bool, status string, payments ...string) int32 {
+		t.Helper()
+		var saleID int32
+		err := pool.QueryRow(ctx, `
+			INSERT INTO sales (user_id, customer_id, sale_date, total, payment_method, is_credit, status)
+			VALUES ($1, $2, NOW() - make_interval(days => $3), $4::NUMERIC, 'fiado', $5, $6)
+			RETURNING id`,
+			userID, customerID, daysAgo, total, isCredit, status).Scan(&saleID)
+		if err != nil {
+			t.Fatalf("seed sale %s: %v", name, err)
+		}
+		for _, amount := range payments {
+			if _, err := pool.Exec(ctx, `
+				INSERT INTO payments (sale_id, amount, payment_method)
+				VALUES ($1, $2::NUMERIC, 'dinheiro')`, saleID, amount); err != nil {
+				t.Fatalf("seed payment for %s: %v", name, err)
+			}
+		}
+		return saleID
+	}
+
+	abertaID := seedSale("aberta", 1, "100.00", true, "completed")
+	parcialID := seedSale("parcial", 2, "200.00", true, "completed", "50.00", "25.00")
+	seedSale("quitada", 3, "80.00", true, "completed", "80.00")
+	seedSale("a vista", 4, "30.00", false, "completed")
+	seedSale("cancelada", 5, "90.00", true, "cancelled")
+
+	// Same customer id must not match another user's sales.
+	var otherCustomerID int32
+	if err := pool.QueryRow(ctx, `
+		INSERT INTO customers (user_id, name) VALUES ($1, 'Cliente Outro') RETURNING id`,
+		otherUserID).Scan(&otherCustomerID); err != nil {
+		t.Fatalf("seed other customer: %v", err)
+	}
+
+	t.Run("GetCustomerByUserIDAndID", func(t *testing.T) {
+		got, err := queries.GetCustomerByUserIDAndID(ctx, db.GetCustomerByUserIDAndIDParams{
+			ID: customerID, UserID: userID,
+		})
+		if err != nil {
+			t.Fatalf("GetCustomerByUserIDAndID: %v", err)
+		}
+		if got.ID != customerID || got.Name != "Cliente Fiado" {
+			t.Fatalf("got %+v", got)
+		}
+
+		_, err = queries.GetCustomerByUserIDAndID(ctx, db.GetCustomerByUserIDAndIDParams{
+			ID: customerID, UserID: otherUserID,
+		})
+		if !errors.Is(err, pgx.ErrNoRows) {
+			t.Fatalf("cross-user lookup err = %v, want pgx.ErrNoRows", err)
+		}
+	})
+
+	t.Run("ListPendingFiadoSalesByCustomer", func(t *testing.T) {
+		rows, err := queries.ListPendingFiadoSalesByCustomer(ctx, db.ListPendingFiadoSalesByCustomerParams{
+			UserID: userID, CustomerID: customerID, RowLimit: 10, RowOffset: 0,
+		})
+		if err != nil {
+			t.Fatalf("ListPendingFiadoSalesByCustomer: %v", err)
+		}
+		if len(rows) != 2 {
+			t.Fatalf("got %d open sales, want 2 (aberta, parcial): %+v", len(rows), rows)
+		}
+
+		// sale_date DESC: aberta (1 day ago) before parcial (2 days ago).
+		if rows[0].ID != abertaID || rows[1].ID != parcialID {
+			t.Fatalf("order = %d,%d, want %d,%d", rows[0].ID, rows[1].ID, abertaID, parcialID)
+		}
+		if got := numericFloat(t, rows[0].TotalPaid); got != 0 {
+			t.Fatalf("aberta total_paid = %v, want 0", got)
+		}
+		if got := numericFloat(t, rows[0].Balance); got != 100 {
+			t.Fatalf("aberta balance = %v, want 100", got)
+		}
+		if got := numericFloat(t, rows[1].TotalPaid); got != 75 {
+			t.Fatalf("parcial total_paid = %v, want 75", got)
+		}
+		if got := numericFloat(t, rows[1].Balance); got != 125 {
+			t.Fatalf("parcial balance = %v, want 125", got)
+		}
+	})
+
+	t.Run("ListPendingFiadoSalesByCustomer paginates", func(t *testing.T) {
+		first, err := queries.ListPendingFiadoSalesByCustomer(ctx, db.ListPendingFiadoSalesByCustomerParams{
+			UserID: userID, CustomerID: customerID, RowLimit: 1, RowOffset: 0,
+		})
+		if err != nil {
+			t.Fatalf("page 1: %v", err)
+		}
+		second, err := queries.ListPendingFiadoSalesByCustomer(ctx, db.ListPendingFiadoSalesByCustomerParams{
+			UserID: userID, CustomerID: customerID, RowLimit: 1, RowOffset: 1,
+		})
+		if err != nil {
+			t.Fatalf("page 2: %v", err)
+		}
+		third, err := queries.ListPendingFiadoSalesByCustomer(ctx, db.ListPendingFiadoSalesByCustomerParams{
+			UserID: userID, CustomerID: customerID, RowLimit: 1, RowOffset: 2,
+		})
+		if err != nil {
+			t.Fatalf("page 3: %v", err)
+		}
+
+		if len(first) != 1 || first[0].ID != abertaID {
+			t.Fatalf("page 1 = %+v", first)
+		}
+		if len(second) != 1 || second[0].ID != parcialID {
+			t.Fatalf("page 2 = %+v", second)
+		}
+		if len(third) != 0 {
+			t.Fatalf("page 3 = %+v, want empty", third)
+		}
+	})
+
+	t.Run("SummarizePendingFiadoSalesByCustomer", func(t *testing.T) {
+		summary, err := queries.SummarizePendingFiadoSalesByCustomer(ctx, db.SummarizePendingFiadoSalesByCustomerParams{
+			UserID: userID, CustomerID: customerID,
+		})
+		if err != nil {
+			t.Fatalf("SummarizePendingFiadoSalesByCustomer: %v", err)
+		}
+		if summary.TotalSales != 2 {
+			t.Fatalf("total_sales = %d, want 2", summary.TotalSales)
+		}
+		// 100.00 (aberta) + 125.00 (parcial)
+		if got := numericFloat(t, summary.TotalDevido); got != 225 {
+			t.Fatalf("total_devido = %v, want 225", got)
+		}
+	})
+
+	t.Run("SummarizePendingFiadoSalesByCustomer with no open sales", func(t *testing.T) {
+		summary, err := queries.SummarizePendingFiadoSalesByCustomer(ctx, db.SummarizePendingFiadoSalesByCustomerParams{
+			UserID: otherUserID, CustomerID: otherCustomerID,
+		})
+		if err != nil {
+			t.Fatalf("SummarizePendingFiadoSalesByCustomer: %v", err)
+		}
+		if summary.TotalSales != 0 {
+			t.Fatalf("total_sales = %d, want 0", summary.TotalSales)
+		}
+		if got := numericFloat(t, summary.TotalDevido); got != 0 {
+			t.Fatalf("total_devido = %v, want 0", got)
+		}
+	})
+}

diff --git a/packages/api-go/internal/fiado/page.go b/packages/api-go/internal/fiado/page.go
--- /dev/null
+++ b/packages/api-go/internal/fiado/page.go
@@ -0,0 +1,51 @@
+package fiado
+
+import (
+	"net/http"
+	"net/url"
+	"strconv"
+
+	"pdv/api-go/internal/apperror"
+)
+
+// NewPage validates page/limit from a query string. Missing or empty values fall back
+// to DefaultPage/DefaultLimit; anything else must be an integer within range.
+func NewPage(query url.Values) (Page, error) {
+	number, err := positiveIntParam(query, "page", DefaultPage, MaxPage)
+	if err != nil {
+		return Page{}, err
+	}
+
+	limit, err := positiveIntParam(query, "limit", DefaultLimit, MaxLimit)
+	if err != nil {
+		return Page{}, err
+	}
+
+	return Page{Number: number, Limit: limit}, nil
+}
+
+// positiveIntParam parses query[name] as an integer between 1 and max.
+func positiveIntParam(query url.Values, name string, fallback, max int) (int, error) {
+	raw := query.Get(name)
+	if raw == "" {
+		return fallback, nil
+	}
+
+	value, err := strconv.Atoi(raw)
+	if err != nil || value < 1 {
+		return 0, apperror.New(
+			"Parâmetro "+name+" inválido",
+			http.StatusBadRequest,
+			"VALIDATION_ERROR",
+		)
+	}
+	if value > max {
+		return 0, apperror.New(
+			"Parâmetro "+name+" acima do máximo de "+strconv.Itoa(max),
+			http.StatusBadRequest,
+			"VALIDATION_ERROR",
+		)
+	}
+
+	return value, nil
+}

diff --git a/packages/api-go/internal/fiado/page_test.go b/packages/api-go/internal/fiado/page_test.go
--- /dev/null
+++ b/packages/api-go/internal/fiado/page_test.go
@@ -0,0 +1,71 @@
+package fiado_test
+
+import (
+	"net/url"
+	"testing"
+
+	"pdv/api-go/internal/fiado"
+)
+
+func TestNewPage_defaultsAndValues(t *testing.T) {
+	cases := []struct {
+		name  string
+		query url.Values
+		want  fiado.Page
+	}{
+		{"empty", url.Values{}, fiado.Page{Number: fiado.DefaultPage, Limit: fiado.DefaultLimit}},
+		{"blank values", url.Values{"page": {""}, "limit": {""}}, fiado.Page{Number: 1, Limit: fiado.DefaultLimit}},
+		{"explicit", url.Values{"page": {"4"}, "limit": {"10"}}, fiado.Page{Number: 4, Limit: 10}},
+		{"max limit", url.Values{"limit": {"100"}}, fiado.Page{Number: 1, Limit: fiado.MaxLimit}},
+	}
+
+	for _, tc := range cases {
+		t.Run(tc.name, func(t *testing.T) {
+			got, err := fiado.NewPage(tc.query)
+			if err != nil {
+				t.Fatalf("NewPage: %v", err)
+			}
+			if got != tc.want {
+				t.Fatalf("got %+v, want %+v", got, tc.want)
+			}
+		})
+	}
+}
+
+func TestNewPage_invalid(t *testing.T) {
+	cases := map[string]url.Values{
+		"page zero":      {"page": {"0"}},
+		"page negative":  {"page": {"-1"}},
+		"page not a int": {"page": {"abc"}},
+		"limit zero":     {"limit": {"0"}},
+		"limit negative": {"limit": {"-5"}},
+		"limit not int":  {"limit": {"x"}},
+		"limit over max": {"limit": {"101"}},
+		"page over max":  {"page": {"1000001"}},
+		"page overflows": {"page": {"99999999999999"}},
+	}
+
+	for name, query := range cases {
+		t.Run(name, func(t *testing.T) {
+			_, err := fiado.NewPage(query)
+			assertAppError(t, err, 400, "VALIDATION_ERROR")
+		})
+	}
+}
+
+func TestPageOffsetAndTotalPages(t *testing.T) {
+	page := fiado.Page{Number: 3, Limit: 20}
+	if got := page.Offset(); got != 40 {
+		t.Fatalf("Offset() = %d, want 40", got)
+	}
+
+	cases := []struct {
+		total int64
+		want  int64
+	}{{0, 0}, {1, 1}, {20, 1}, {21, 2}, {41, 3}}
+	for _, tc := range cases {
+		if got := page.TotalPages(tc.total); got != tc.want {
+			t.Fatalf("TotalPages(%d) = %d, want %d", tc.total, got, tc.want)
+		}
+	}
+}

diff --git a/packages/api-go/internal/fiado/pending.go b/packages/api-go/internal/fiado/pending.go
--- /dev/null
+++ b/packages/api-go/internal/fiado/pending.go
@@ -0,0 +1,107 @@
+package fiado
+
+import (
+	"context"
+	"errors"
+	"net/http"
+	"time"
+
+	"github.com/jackc/pgx/v5"
+	"github.com/jackc/pgx/v5/pgtype"
+
+	"pdv/api-go/internal/apperror"
+	"pdv/api-go/internal/db"
+)
+
+// PendingStore loads the rows behind GET /api/v1/customers/{id}/fiado.
+type PendingStore interface {
+	GetCustomerByUserIDAndID(ctx context.Context, arg db.GetCustomerByUserIDAndIDParams) (db.Customer, error)
+	ListPendingFiadoSalesByCustomer(ctx context.Context, arg db.ListPendingFiadoSalesByCustomerParams) ([]db.ListPendingFiadoSalesByCustomerRow, error)
+	SummarizePendingFiadoSalesByCustomer(ctx context.Context, arg db.SummarizePendingFiadoSalesByCustomerParams) (db.SummarizePendingFiadoSalesByCustomerRow, error)
+}
+
+// PendingService lists the fiado sales a customer has not settled yet.
+type PendingService struct {
+	store PendingStore
+}
+
+func NewPendingService(store PendingStore) *PendingService {
+	return &PendingService{store: store}
+}
+
+// ListPending returns one page of open fiado sales plus the total owed across all of them.
+// Returns a 404 AppError when the customer does not belong to the user (or does not exist).
+func (s *PendingService) ListPending(ctx context.Context, userID, customerID int32, page Page) (PendingResponse, error) {
+	if _, err := s.store.GetCustomerByUserIDAndID(ctx, db.GetCustomerByUserIDAndIDParams{
+		ID:     customerID,
+		UserID: userID,
+	}); err != nil {
+		if errors.Is(err, pgx.ErrNoRows) {
+			return PendingResponse{}, apperror.New("Cliente não encontrado", http.StatusNotFound, "CUSTOMER_NOT_FOUND")
+		}
+		return PendingResponse{}, internalError()
+	}
+
+	summary, err := s.store.SummarizePendingFiadoSalesByCustomer(ctx, db.SummarizePendingFiadoSalesByCustomerParams{
+		UserID:     userID,
+		CustomerID: customerID,
+	})
+	if err != nil {
+		return PendingResponse{}, internalError()
+	}
+
+	out := PendingResponse{
+		Success:     true,
+		CustomerID:  customerID,
+		Data:        []PendingSale{},
+		TotalDevido: numericFloat(summary.TotalDevido),
+		Pagination: Pagination{
+			Page:       page.Number,
+			Limit:      page.Limit,
+			Total:      summary.TotalSales,
+			TotalPages: page.TotalPages(summary.TotalSales),
+		},
+	}
+
+	rows, err := s.store.ListPendingFiadoSalesByCustomer(ctx, db.ListPendingFiadoSalesByCustomerParams{
+		UserID:     userID,
+		CustomerID: customerID,
+		RowLimit:   int32(page.Limit),
+		RowOffset:  page.Offset(),
+	})
+	if err != nil {
+		return PendingResponse{}, internalError()
+	}
+
+	for _, row := range rows {
+		saleDate, _ := timestamptzTime(row.SaleDate)
+		out.Data = append(out.Data, PendingSale{
+			SaleID:        row.ID,
+			Data:          saleDate,
+			ValorOriginal: numericFloat(row.Total),
+			ValorPago:     numericFloat(row.TotalPaid),
+			Saldo:         numericFloat(row.Balance),
+		})
+	}
+
+	return out, nil
+}
+
+func internalError() error {
+	return apperror.New("Erro ao buscar fiado do cliente", http.StatusInternalServerError, "INTERNAL_ERROR")
+}
+
+func numericFloat(n pgtype.Numeric) float64 {
+	f, err := n.Float64Value()
+	if err != nil || !f.Valid {
+		return 0
+	}
+	return f.Float64
+}
+
+func timestamptzTime(t pgtype.Timestamptz) (time.Time, bool) {
+	if !t.Valid {
+		return time.Time{}, false
+	}
+	return t.Time, true
+}

diff --git a/packages/api-go/internal/fiado/pending_test.go b/packages/api-go/internal/fiado/pending_test.go
--- /dev/null
+++ b/packages/api-go/internal/fiado/pending_test.go
@@ -0,0 +1,243 @@
+package fiado_test
+
+import (
+	"context"
+	"errors"
+	"net/url"
+	"testing"
+	"time"
+
+	"github.com/jackc/pgx/v5"
+	"github.com/jackc/pgx/v5/pgtype"
+
+	"pdv/api-go/internal/apperror"
+	"pdv/api-go/internal/db"
+	"pdv/api-go/internal/fiado"
+)
+
+const (
+	testUserID     int32 = 7
+	testCustomerID int32 = 42
+)
+
+type stubStore struct {
+	customer    db.Customer
+	customerErr error
+
+	rows    []db.ListPendingFiadoSalesByCustomerRow
+	rowsErr error
+
+	summary    db.SummarizePendingFiadoSalesByCustomerRow
+	summaryErr error
+
+	listParams db.ListPendingFiadoSalesByCustomerParams
+}
+
+func (s *stubStore) GetCustomerByUserIDAndID(_ context.Context, arg db.GetCustomerByUserIDAndIDParams) (db.Customer, error) {
+	if s.customerErr != nil {
+		return db.Customer{}, s.customerErr
+	}
+	if arg.ID != s.customer.ID || arg.UserID != s.customer.UserID {
+		return db.Customer{}, pgx.ErrNoRows
+	}
+	return s.customer, nil
+}
+
+func (s *stubStore) ListPendingFiadoSalesByCustomer(_ context.Context, arg db.ListPendingFiadoSalesByCustomerParams) ([]db.ListPendingFiadoSalesByCustomerRow, error) {
+	s.listParams = arg
+	return s.rows, s.rowsErr
+}
+
+func (s *stubStore) SummarizePendingFiadoSalesByCustomer(_ context.Context, _ db.SummarizePendingFiadoSalesByCustomerParams) (db.SummarizePendingFiadoSalesByCustomerRow, error) {
+	return s.summary, s.summaryErr
+}
+
+func mustNumeric(t *testing.T, s string) pgtype.Numeric {
+	t.Helper()
+	var n pgtype.Numeric
+	if err := n.Scan(s); err != nil {
+		t.Fatalf("scan numeric %q: %v", s, err)
+	}
+	return n
+}
+
+func knownCustomer() db.Customer {
+	return db.Customer{ID: testCustomerID, UserID: testUserID, Name: "Cliente Fiado", Active: true}
+}
+
+func defaultPage(t *testing.T) fiado.Page {
+	t.Helper()
+	page, err := fiado.NewPage(url.Values{})
+	if err != nil {
+		t.Fatalf("NewPage: %v", err)
+	}
+	return page
+}
+
+func TestListPending_success(t *testing.T) {
+	saleDate := time.Date(2026, 3, 4, 12, 0, 0, 0, time.UTC)
+	store := &stubStore{
+		customer: knownCustomer(),
+		summary: db.SummarizePendingFiadoSalesByCustomerRow{
+			TotalSales:  2,
+			TotalDevido: mustNumeric(t, "130.00"),
+		},
+		rows: []db.ListPendingFiadoSalesByCustomerRow{
+			{
+				ID:        11,
+				SaleDate:  pgtype.Timestamptz{Time: saleDate, Valid: true},
+				Total:     mustNumeric(t, "100.00"),
+				TotalPaid: mustNumeric(t, "30.00"),
+				Balance:   mustNumeric(t, "70.00"),
+			},
+			{
+				ID:        9,
+				SaleDate:  pgtype.Timestamptz{Time: saleDate.Add(-24 * time.Hour), Valid: true},
+				Total:     mustNumeric(t, "60.00"),
+				TotalPaid: mustNumeric(t, "0"),
+				Balance:   mustNumeric(t, "60.00"),
+			},
+		},
+	}
+
+	out, err := fiado.NewPendingService(store).
+		ListPending(context.Background(), testUserID, testCustomerID, defaultPage(t))
+	if err != nil {
+		t.Fatalf("ListPending: %v", err)
+	}
+
+	if !out.Success || out.CustomerID != testCustomerID {
+		t.Fatalf("got %+v", out)
+	}
+	if out.TotalDevido != 130 {
+		t.Fatalf("TotalDevido = %v, want 130", out.TotalDevido)
+	}
+	if len(out.Data) != 2 {
+		t.Fatalf("got %d sales, want 2", len(out.Data))
+	}
+
+	first := out.Data[0]
+	if first.SaleID != 11 || !first.Data.Equal(saleDate) {
+		t.Fatalf("first sale = %+v", first)
+	}
+	if first.ValorOriginal != 100 || first.ValorPago != 30 || first.Saldo != 70 {
+		t.Fatalf("first amounts = %+v", first)
+	}
+
+	want := fiado.Pagination{Page: 1, Limit: fiado.DefaultLimit, Total: 2, TotalPages: 1}
+	if out.Pagination != want {
+		t.Fatalf("pagination = %+v, want %+v", out.Pagination, want)
+	}
+}
+
+// total_devido must cover every open sale, not only the ones on the requested page.
+func TestListPending_totalDevidoSpansAllPages(t *testing.T) {
+	store := &stubStore{
+		customer: knownCustomer(),
+		summary: db.SummarizePendingFiadoSalesByCustomerRow{
+			TotalSales:  5,
+			TotalDevido: mustNumeric(t, "500.00"),
+		},
+		rows: []db.ListPendingFiadoSalesByCustomerRow{{
+			ID:        3,
+			SaleDate:  pgtype.Timestamptz{Time: time.Now(), Valid: true},
+			Total:     mustNumeric(t, "100.00"),
+			TotalPaid: mustNumeric(t, "0"),
+			Balance:   mustNumeric(t, "100.00"),
+		}},
+	}
+
+	page, err := fiado.NewPage(url.Values{"page": {"3"}, "limit": {"2"}})
+	if err != nil {
+		t.Fatalf("NewPage: %v", err)
+	}
+
+	out, err := fiado.NewPendingService(store).
+		ListPending(context.Background(), testUserID, testCustomerID, page)
+	if err != nil {
+		t.Fatalf("ListPending: %v", err)
+	}
+
+	if out.TotalDevido != 500 {
+		t.Fatalf("TotalDevido = %v, want 500 (all open sales)", out.TotalDevido)
+	}
+	if store.listParams.RowLimit != 2 || store.listParams.RowOffset != 4 {
+		t.Fatalf("limit/offset = %d/%d, want 2/4", store.listParams.RowLimit, store.listParams.RowOffset)
+	}
+
+	want := fiado.Pagination{Page: 3, Limit: 2, Total: 5, TotalPages: 3}
+	if out.Pagination != want {
+		t.Fatalf("pagination = %+v, want %+v", out.Pagination, want)
+	}
+}
+
+func TestListPending_emptyDataIsNotNull(t *testing.T) {
+	store := &stubStore{
+		customer: knownCustomer(),
+		summary: db.SummarizePendingFiadoSalesByCustomerRow{
+			TotalSales:  0,
+			TotalDevido: mustNumeric(t, "0"),
+		},
+	}
+
+	out, err := fiado.NewPendingService(store).
+		ListPending(context.Background(), testUserID, testCustomerID, defaultPage(t))
+	if err != nil {
+		t.Fatalf("ListPending: %v", err)
+	}
+
+	if out.Data == nil {
+		t.Fatal("Data = nil, want empty slice")
+	}
+	if out.TotalDevido != 0 || out.Pagination.Total != 0 || out.Pagination.TotalPages != 0 {
+		t.Fatalf("got %+v", out)
+	}
+}
+
+func TestListPending_unknownCustomerIs404(t *testing.T) {
+	store := &stubStore{customer: knownCustomer()}
+
+	_, err := fiado.NewPendingService(store).
+		ListPending(context.Background(), testUserID, 999, defaultPage(t))
+
+	assertAppError(t, err, 404, "CUSTOMER_NOT_FOUND")
+}
+
+// A customer owned by another user must not leak: the query filters by user_id.
+func TestListPending_customerOfAnotherUserIs404(t *testing.T) {
+	store := &stubStore{customer: knownCustomer()}
+
+	_, err := fiado.NewPendingService(store).
+		ListPending(context.Background(), testUserID+1, testCustomerID, defaultPage(t))
+
+	assertAppError(t, err, 404, "CUSTOMER_NOT_FOUND")
+}
+
+func TestListPending_storeFailures(t *testing.T) {
+	boom := errors.New("boom")
+
+	cases := map[string]*stubStore{
+		"customer lookup": {customer: knownCustomer(), customerErr: boom},
+		"summary":         {customer: knownCustomer(), summaryErr: boom},
+		"list":            {customer: knownCustomer(), rowsErr: boom},
+	}
+
+	for name, store := range cases {
+		t.Run(name, func(t *testing.T) {
+			_, err := fiado.NewPendingService(store).
+				ListPending(context.Background(), testUserID, testCustomerID, defaultPage(t))
+			assertAppError(t, err, 500, "INTERNAL_ERROR")
+		})
+	}
+}
+
+func assertAppError(t *testing.T, err error, status int, code string) {
+	t.Helper()
+	var appErr *apperror.AppError
+	if !errors.As(err, &appErr) {
+		t.Fatalf("err = %v, want *apperror.AppError", err)
+	}
+	if appErr.StatusCode != status || appErr.Code != code {
+		t.Fatalf("err = %d/%s, want %d/%s", appErr.StatusCode, appErr.Code, status, code)
+	}
+}

diff --git a/packages/api-go/internal/fiado/types.go b/packages/api-go/internal/fiado/types.go
--- /dev/null
+++ b/packages/api-go/internal/fiado/types.go
@@ -0,0 +1,66 @@
+package fiado
+
+import "time"
+
+// Defaults and bounds for the page/limit query params of GET /api/v1/customers/{id}/fiado.
+// MaxPage keeps (page-1)*limit inside int32, the SQL OFFSET type.
+const (
+	DefaultPage  = 1
+	DefaultLimit = 20
+	MaxLimit     = 100
+	MaxPage      = 1_000_000
+)
+
+// PendingResponse is the success body from GET /api/v1/customers/{id}/fiado.
+// TotalDevido soma o saldo de todas as vendas em aberto, não apenas as da página.
+type PendingResponse struct {
+	Success     bool          `json:"success"`
+	CustomerID  int32         `json:"customer_id"`
+	Data        []PendingSale `json:"data"`
+	TotalDevido float64       `json:"total_devido"`
+	Pagination  Pagination    `json:"pagination"`
+}
+
+// PendingSale is one fiado sale still open (valor pago menor que o valor original).
+type PendingSale struct {
+	SaleID        int32     `json:"sale_id"`
+	Data          time.Time `json:"data"`
+	ValorOriginal float64   `json:"valor_original"`
+	ValorPago     float64   `json:"valor_pago"`
+	Saldo         float64   `json:"saldo"`
+}
+
+// Pagination describes the returned page and the full result set.
+type Pagination struct {
+	Page       int   `json:"page"`
+	Limit      int   `json:"limit"`
+	Total      int64 `json:"total"`
+	TotalPages int64 `json:"total_pages"`
+}
+
+// FailureResponse is the error body for fiado routes (same shape as sync.FailureResponse).
+type FailureResponse struct {
+	Success bool   `json:"success"`
+	Message string `json:"message"`
+	Code    string `json:"code,omitempty"`
+}
+
+// Page is a validated page/limit pair. Build it with NewPage.
+type Page struct {
+	Number int
+	Limit  int
+}
+
+// Offset is the SQL OFFSET for the page.
+func (p Page) Offset() int32 {
+	return int32((p.Number - 1) * p.Limit)
+}
+
+// TotalPages is the number of pages needed for total rows at this limit.
+func (p Page) TotalPages(total int64) int64 {
+	if total <= 0 {
+		return 0
+	}
+	limit := int64(p.Limit)
+	return (total + limit - 1) / limit
+}

diff --git a/packages/api-go/internal/handler/fiado.go b/packages/api-go/internal/handler/fiado.go
--- /dev/null
+++ b/packages/api-go/internal/handler/fiado.go
@@ -0,0 +1,77 @@
+package handler
+
+import (
+	"context"
+	"errors"
+	"net/http"
+	"strconv"
+
+	"github.com/go-chi/chi/v5"
+
+	"pdv/api-go/internal/apperror"
+	"pdv/api-go/internal/auth"
+	"pdv/api-go/internal/fiado"
+	"pdv/api-go/internal/httpx"
+)
+
+// PendingFiadoLister loads data for GET /api/v1/customers/{id}/fiado.
+type PendingFiadoLister interface {
+	ListPending(ctx context.Context, userID, customerID int32, page fiado.Page) (fiado.PendingResponse, error)
+}
+
+// CustomerFiado handles GET /api/v1/customers/{id}/fiado.
+func CustomerFiado(lister PendingFiadoLister) http.HandlerFunc {
+	return func(w http.ResponseWriter, r *http.Request) {
+		userID, ok := auth.UserIDFromContext(r.Context())
+		if !ok {
+			writeFiadoFailure(w, apperror.New("Usuário não autenticado", http.StatusUnauthorized, "UNAUTHENTICATED"))
+			return
+		}
+
+		customerID, err := customerIDParam(chi.URLParam(r, "id"))
+		if err != nil {
+			writeFiadoFailure(w, err)
+			return
+		}
+
+		page, err := fiado.NewPage(r.URL.Query())
+		if err != nil {
+			writeFiadoFailure(w, err)
+			return
+		}
+
+		out, err := lister.ListPending(r.Context(), userID, customerID, page)
+		if err != nil {
+			writeFiadoFailure(w, err)
+			return
+		}
+
+		_ = httpx.WriteJSON(w, http.StatusOK, out)
+	}
+}
+
+// customerIDParam parses {id} as a positive int32 (customers.id is SERIAL).
+func customerIDParam(raw string) (int32, error) {
+	value, err := strconv.ParseInt(raw, 10, 32)
+	if err != nil || value < 1 {
+		return 0, apperror.New("ID do cliente inválido", http.StatusBadRequest, "VALIDATION_ERROR")
+	}
+	return int32(value), nil
+}
+
+func writeFiadoFailure(w http.ResponseWriter, err error) {
+	var appErr *apperror.AppError
+	if !errors.As(err, &appErr) {
+		_ = httpx.WriteJSON(w, http.StatusInternalServerError, fiado.FailureResponse{
+			Success: false,
+			Message: "Erro ao buscar fiado do cliente",
+			Code:    "INTERNAL_ERROR",
+		})
+		return
+	}
+	_ = httpx.WriteJSON(w, appErr.StatusCode, fiado.FailureResponse{
+		Success: false,
+		Message: appErr.Message,
+		Code:    appErr.Code,
+	})
+}

diff --git a/packages/api-go/internal/handler/fiado_router.go b/packages/api-go/internal/handler/fiado_router.go
--- /dev/null
+++ b/packages/api-go/internal/handler/fiado_router.go
@@ -0,0 +1,27 @@
+package handler
+
+import (
+	"github.com/go-chi/chi/v5"
+
+	"pdv/api-go/internal/auth"
+	"pdv/api-go/internal/fiado"
+	apimw "pdv/api-go/internal/middleware"
+)
+
+// FiadoDeps groups dependencies for /api/v1/customers routes.
+type FiadoDeps struct {
+	Users   apimw.UserLookup
+	Tokens  auth.AccessTokenParser
+	Pending PendingFiadoLister
+}
+
+// MountFiado registers GET /api/v1/customers/{id}/fiado.
+func MountFiado(router chi.Router, deps FiadoDeps) {
+	router.Route("/api/v1/customers", func(r chi.Router) {
+		r.Use(apimw.Bearer(deps.Users, deps.Tokens))
+		r.Get("/{id}/fiado", CustomerFiado(deps.Pending))
+	})
+}
+
+// Compile-time check for FiadoDeps services.
+var _ PendingFiadoLister = (*fiado.PendingService)(nil)

diff --git a/packages/api-go/internal/handler/fiado_router_test.go b/packages/api-go/internal/handler/fiado_router_test.go
--- /dev/null
+++ b/packages/api-go/internal/handler/fiado_router_test.go
@@ -0,0 +1,222 @@
+package handler_test
+
+import (
+	"context"
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
+	"testing"
+	"time"
+
+	"github.com/go-chi/chi/v5"
+
+	"pdv/api-go/internal/apperror"
+	"pdv/api-go/internal/auth"
+	"pdv/api-go/internal/db"
+	"pdv/api-go/internal/fiado"
+	"pdv/api-go/internal/handler"
+)
+
+const fiadoUserID int32 = 5
+
+type stubPendingFiadoLister struct {
+	out fiado.PendingResponse
+	err error
+
+	gotUserID     int32
+	gotCustomerID int32
+	gotPage       fiado.Page
+}
+
+func (s *stubPendingFiadoLister) ListPending(_ context.Context, userID, customerID int32, page fiado.Page) (fiado.PendingResponse, error) {
+	s.gotUserID = userID
+	s.gotCustomerID = customerID
+	s.gotPage = page
+	return s.out, s.err
+}
+
+// newFiadoRouter mounts the fiado routes with a bearer-authenticated stub user.
+func newFiadoRouter(t *testing.T, lister handler.PendingFiadoLister) (chi.Router, string) {
+	t.Helper()
+	issuer := auth.NewTestTokenIssuer()
+	token, err := issuer.IssueAccessToken(fiadoUserID)
+	if err != nil {
+		t.Fatal(err)
+	}
+
+	router := chi.NewRouter()
+	handler.MountFiado(router, handler.FiadoDeps{
+		Users:   stubUserLookup{user: db.User{ID: fiadoUserID}},
+		Tokens:  issuer,
+		Pending: lister,
+	})
+	return router, token
+}
+
+func doFiadoRequest(t *testing.T, router chi.Router, token, target string) *httptest.ResponseRecorder {
+	t.Helper()
+	req := httptest.NewRequest(http.MethodGet, target, nil)
+	if token != "" {
+		req.Header.Set("Authorization", "Bearer "+token)
+	}
+	rec := httptest.NewRecorder()
+	router.ServeHTTP(rec, req)
+	return rec
+}
+
+func TestCustomerFiado_success(t *testing.T) {
+	saleDate := time.Date(2026, 3, 4, 12, 0, 0, 0, time.UTC)
+	lister := &stubPendingFiadoLister{out: fiado.PendingResponse{
+		Success:    true,
+		CustomerID: 42,
+		Data: []fiado.PendingSale{{
+			SaleID: 11, Data: saleDate, ValorOriginal: 100, ValorPago: 30, Saldo: 70,
+		}},
+		TotalDevido: 70,
+		Pagination:  fiado.Pagination{Page: 1, Limit: 20, Total: 1, TotalPages: 1},
+	}}
+
+	router, token := newFiadoRouter(t, lister)
+	rec := doFiadoRequest(t, router, token, "/api/v1/customers/42/fiado")
+
+	if rec.Code != http.StatusOK {
+		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
+	}
+
+	var got fiado.PendingResponse
+	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
+		t.Fatal(err)
+	}
+	if !got.Success || got.TotalDevido != 70 || len(got.Data) != 1 {
+		t.Fatalf("got %+v", got)
+	}
+	if got.Data[0].SaleID != 11 || got.Data[0].Saldo != 70 {
+		t.Fatalf("sale = %+v", got.Data[0])
+	}
+
+	if lister.gotUserID != fiadoUserID || lister.gotCustomerID != 42 {
+		t.Fatalf("service got user %d customer %d", lister.gotUserID, lister.gotCustomerID)
+	}
+	if lister.gotPage != (fiado.Page{Number: fiado.DefaultPage, Limit: fiado.DefaultLimit}) {
+		t.Fatalf("page = %+v, want defaults", lister.gotPage)
+	}
+}
+
+// The JSON must carry the keys the desktop client reads, in snake_case.
+func TestCustomerFiado_responseKeys(t *testing.T) {
+	lister := &stubPendingFiadoLister{out: fiado.PendingResponse{
+		Success:    true,
+		CustomerID: 42,
+		Data: []fiado.PendingSale{{
+			SaleID: 11, Data: time.Now(), ValorOriginal: 100, ValorPago: 30, Saldo: 70,
+		}},
+		TotalDevido: 70,
+		Pagination:  fiado.Pagination{Page: 1, Limit: 20, Total: 1, TotalPages: 1},
+	}}
+
+	router, token := newFiadoRouter(t, lister)
+	rec := doFiadoRequest(t, router, token, "/api/v1/customers/42/fiado")
+
+	var body map[string]json.RawMessage
+	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
+		t.Fatal(err)
+	}
+	for _, key := range []string{"success", "customer_id", "data", "total_devido", "pagination"} {
+		if _, ok := body[key]; !ok {
+			t.Fatalf("missing key %q in %s", key, rec.Body.String())
+		}
+	}
+
+	var items []map[string]json.RawMessage
+	if err := json.Unmarshal(body["data"], &items); err != nil {
+		t.Fatal(err)
+	}
+	for _, key := range []string{"sale_id", "data", "valor_original", "valor_pago", "saldo"} {
+		if _, ok := items[0][key]; !ok {
+			t.Fatalf("missing key %q in data[0]: %s", key, rec.Body.String())
+		}
+	}
+}
+
+func TestCustomerFiado_forwardsPagination(t *testing.T) {
+	lister := &stubPendingFiadoLister{out: fiado.PendingResponse{Success: true, Data: []fiado.PendingSale{}}}
+
+	router, token := newFiadoRouter(t, lister)
+	rec := doFiadoRequest(t, router, token, "/api/v1/customers/42/fiado?page=3&limit=5")
+
+	if rec.Code != http.StatusOK {
+		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
+	}
+	if lister.gotPage != (fiado.Page{Number: 3, Limit: 5}) {
+		t.Fatalf("page = %+v, want {3 5}", lister.gotPage)
+	}
+}
+
+func TestCustomerFiado_unknownCustomerIs404(t *testing.T) {
+	lister := &stubPendingFiadoLister{
+		err: apperror.New("Cliente não encontrado", http.StatusNotFound, "CUSTOMER_NOT_FOUND"),
+	}
+
+	router, token := newFiadoRouter(t, lister)
+	rec := doFiadoRequest(t, router, token, "/api/v1/customers/999/fiado")
+
+	if rec.Code != http.StatusNotFound {
+		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
+	}
+
+	var got fiado.FailureResponse
+	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
+		t.Fatal(err)
+	}
+	if got.Success || got.Code != "CUSTOMER_NOT_FOUND" {
+		t.Fatalf("got %+v", got)
+	}
+}
+
+func TestCustomerFiado_invalidParams(t *testing.T) {
+	cases := map[string]string{
+		"non numeric id": "/api/v1/customers/abc/fiado",
+		"zero id":        "/api/v1/customers/0/fiado",
+		"id overflow":    "/api/v1/customers/99999999999/fiado",
+		"page zero":      "/api/v1/customers/42/fiado?page=0",
+		"limit over max": "/api/v1/customers/42/fiado?limit=101",
+		"limit not int":  "/api/v1/customers/42/fiado?limit=abc",
+	}
+
+	for name, target := range cases {
+		t.Run(name, func(t *testing.T) {
+			lister := &stubPendingFiadoLister{}
+			router, token := newFiadoRouter(t, lister)
+			rec := doFiadoRequest(t, router, token, target)
+
+			if rec.Code != http.StatusBadRequest {
+				t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
+			}
+			if lister.gotCustomerID != 0 {
+				t.Fatal("service was called for an invalid request")
+			}
+		})
+	}
+}
+
+func TestCustomerFiado_requiresBearerToken(t *testing.T) {
+	router, _ := newFiadoRouter(t, &stubPendingFiadoLister{})
+	rec := doFiadoRequest(t, router, "", "/api/v1/customers/42/fiado")
+
+	if rec.Code != http.StatusUnauthorized {
+		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
+	}
+}
+
+func TestCustomerFiado_serviceFailureIs500(t *testing.T) {
+	lister := &stubPendingFiadoLister{
+		err: apperror.New("Erro ao buscar fiado do cliente", http.StatusInternalServerError, "INTERNAL_ERROR"),
+	}
+
+	router, token := newFiadoRouter(t, lister)
+	rec := doFiadoRequest(t, router, token, "/api/v1/customers/42/fiado")
+
+	if rec.Code != http.StatusInternalServerError {
+		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
+	}
+}

diff --git a/packages/api-go/query/fiado.sql b/packages/api-go/query/fiado.sql
--- /dev/null
+++ b/packages/api-go/query/fiado.sql
@@ -0,0 +1,57 @@
+-- Fiado (vendas a crédito) em aberto por cliente.
+-- Paridade com SaleRepository::find_pending_credit_sales_by_customer (desktop):
+-- is_credit, status 'completed' e total pago menor que o total da venda.
+
+-- name: GetCustomerByUserIDAndID :one
+SELECT
+    id,
+    user_id,
+    name,
+    document,
+    phone,
+    email,
+    address,
+    active,
+    created_at,
+    updated_at
+FROM customers
+WHERE id = sqlc.arg(id)
+  AND user_id = sqlc.arg(user_id);
+
+-- name: ListPendingFiadoSalesByCustomer :many
+SELECT
+    s.id,
+    s.sale_date,
+    s.total,
+    COALESCE(p.total_paid, 0)::NUMERIC AS total_paid,
+    (s.total - COALESCE(p.total_paid, 0))::NUMERIC AS balance
+FROM sales s
+LEFT JOIN (
+    SELECT sale_id, SUM(amount) AS total_paid
+    FROM payments
+    GROUP BY sale_id
+) p ON p.sale_id = s.id
+WHERE s.user_id = sqlc.arg(user_id)
+  AND s.customer_id = sqlc.arg(customer_id)::INT
+  AND s.is_credit = TRUE
+  AND s.status = 'completed'
+  AND COALESCE(p.total_paid, 0) < s.total
+ORDER BY s.sale_date DESC, s.id DESC
+LIMIT sqlc.arg(row_limit)
+OFFSET sqlc.arg(row_offset);
+
+-- name: SummarizePendingFiadoSalesByCustomer :one
+SELECT
+    COUNT(*)::BIGINT AS total_sales,
+    COALESCE(SUM(s.total - COALESCE(p.total_paid, 0)), 0)::NUMERIC AS total_devido
+FROM sales s
+LEFT JOIN (
+    SELECT sale_id, SUM(amount) AS total_paid
+    FROM payments
+    GROUP BY sale_id
+) p ON p.sale_id = s.id
+WHERE s.user_id = sqlc.arg(user_id)
+  AND s.customer_id = sqlc.arg(customer_id)::INT
+  AND s.is_credit = TRUE
+  AND s.status = 'completed'
+  AND COALESCE(p.total_paid, 0) < s.total;

```

## Invariantes do repositório — AGENTS.md
# AGENTS.md

Guidance for AI agents working in this repository.

## Project Overview

This is a PDV monorepo for a point-of-sale system.

- `packages/desktop`: Tauri 2 desktop app with React, TypeScript, Vite, Rust, and local SQLite.
- `packages/api-go`: Cloud API in Go with Chi, pgx, sqlc, goose migrations, PostgreSQL, JWT auth, sync endpoints, and mock NF-e provider.
- Root `package.json`: npm workspace entrypoint for the desktop package plus helper scripts for API and build commands.

The business domain is Brazilian POS terminology. Preserve existing names such as PDV, PAF, NFC-e, fiado, notas, and sync unless the task explicitly asks for a rename.

## Repository Layout

- `README.md`: high-level setup and commands.
- `packages/desktop/src`: React UI, routes, contexts, services, utilities, and CSS.
- `packages/desktop/src-tauri/src`: Rust/Tauri backend, commands, SQLite repositories, services, printer, sync, PAF, and models.
- `packages/desktop/src-tauri/src/database`: SQLite connection and migrations used by the desktop app.
- `packages/api-go/cmd/server`: Go API entrypoint.
- `packages/api-go/internal`: Go application packages. Keep private app code here; do not add `pkg/` for private code.
- `packages/api-go/query`: source SQL queries for sqlc.
- `packages/api-go/db/schema.sql`: source schema used by sqlc.
- `packages/api-go/internal/db`: generated sqlc Go code. Do not edit by hand.
- `packages/api-go/migrations`: goose PostgreSQL migrations.

## Required Tooling

- Node.js `>=20` and npm `>=9`.
- Go as declared in `packages/api-go/go.mod`.
- Rust stable for Tauri builds.
- PostgreSQL for API integration tests and local API development.
- Docker/Compose is optional for the API local stack.

## Common Commands

Run commands from the repository root unless noted.

- Install dependencies: `npm install`
- Start Vite desktop frontend: `npm run dev`
- Start Tauri desktop app: `npm run dev:desktop:tauri`
- Build desktop frontend: `npm run build`
- Build Tauri desktop app: `npm run build:desktop:tauri`
- Typecheck workspaces: `npm run typecheck`
- Start Go API: `npm run dev:api`
- Build Go API: `make -C packages/api-go build`
- Run Go tests: `make -C packages/api-go test`
- Run Go integration tests: set `TEST_DATABASE_URL` or `DATABASE_URL`, then `make -C packages/api-go test-integration`
- Generate sqlc code: `make -C packages/api-go sqlc`
- Run migrations: set `DATABASE_URL`, then `make -C packages/api-go migrate-up`
- Start API Docker stack: copy `packages/api-go/.env.example` to `packages/api-go/.env`, adjust values, then `make -C packages/api-go docker-up`
- Stop API Docker stack: `make -C packages/api-go docker-down`

For Rust-only checks in the desktop backend, run from `packages/desktop`: `cargo check` or `cargo test`.

## Environment

- API env example: `packages/api-go/.env.example`.
- Desktop env values must use Vite prefixes, for example `VITE_API_URL` or the existing `VITE_API_BASE_URL` usage.
- Never commit real `.env` files, tokens, keys, API credentials, database dumps, or customer fiscal data.
- The Go API reads configuration from environment variables; the Makefile only exports `packages/api-go/.env` for targets run from that directory.

## Go API Guidelines

- Follow `.cursor/rules/RULES.md` for Go conventions in this repository.
- Prefer standard library packages before adding dependencies, especially `net/http`, `context`, and `log/slog`.
- Functions that perform or may perform network I/O should accept `context.Context` as the first parameter named `ctx`.
- Return errors from lower layers and log at process or handler boundaries.
- Wrap inspectable errors with `%w`.
- Use table-driven tests for pure logic and `httptest` for HTTP behavior.
- Keep SQL source in `packages/api-go/query` and `packages/api-go/db/schema.sql`, then regenerate `internal/db` with `make -C packages/api-go sqlc`.
- Do not manually edit generated files under `packages/api-go/internal/db`.
- For database changes, update both the goose migration path and sqlc schema/query sources when needed.

## Desktop Guidelines

- React code lives in `packages/desktop/src`; Tauri Rust code lives in `packages/desktop/src-tauri/src`.
- Keep TypeScript strict-clean. The desktop build runs `tsc && vite build`.
- Frontend calls into Tauri commands through `@tauri-apps/api/core` `invoke` wrappers in `src/services`.
- When adding or renaming a Tauri command, update both the Rust command registration and the TypeScript service wrapper/types.
- Preserve existing UI structure and Portuguese user-facing copy unless asked otherwise.
- SQLite schema and data behavior for the desktop app belong in the Rust database/repository/service layers, not directly in React components.
- Do not introduce browser-only APIs in code that must run inside the Tauri backend.

## Testing And Verification

Choose the narrowest verification that covers the change.

- Frontend TypeScript/UI change: `npm run build:desktop` or `npm run typecheck`.
- Tauri/Rust backend change: run `cargo check` from `packages/desktop`; use `cargo test` when tests exist or behavior is covered.
- Go API pure/backend change: `make -C packages/api-go test`.
- Go DB/query/migration change: run `make -C packages/api-go sqlc`, then `make -C packages/api-go test`; use integration tests when database behavior changed.
- Root scripts/package changes: run the affected `npm run ...` command from root.

If a command cannot run because required services or env vars are missing, report that clearly with the exact missing prerequisite.

## Dependency Policy

- Keep changes minimal and use existing libraries/patterns first.
- Add third-party modules only when there is a clear benefit; mention the reason in the final response or PR description.
- Keep `package-lock.json`, `go.sum`, and Cargo lockfiles consistent with manifest changes.

## Generated And Build Artifacts

- Do not edit generated sqlc files in `packages/api-go/internal/db` manually.
- Do not commit `node_modules`, local database files, build output, or `.env` files.
- Before changing ignored/local files, verify they are intentionally part of the task.

## Collaboration Rules

- Do not revert user changes unless explicitly asked.
- Prefer small, targeted changes over broad rewrites.
- Update documentation when commands, env vars, package layout, or setup behavior changes.
- Keep final responses concise and include what changed plus what verification was run.
