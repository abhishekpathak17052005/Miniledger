# MiniLedger Backend API & Database

Backend service and database layer for MiniLedger, built with Node.js, Express, TypeScript, Prisma ORM, and PostgreSQL.

---

## 🗄️ Database Architecture & Prisma Setup

MiniLedger uses **PostgreSQL** with **Prisma ORM** for fully type-safe queries, relational foreign key constraints, cascade deletes, and ACID compliance.

### Models & Schema

- **User**:
  - `id`: Unique identifier (`cuid`).
  - `phone`: Unique 10-digit mobile number.
  - `createdAt`: Registration timestamp (`DateTime`).
  - `updatedAt`: Auto-updating timestamp (`DateTime`).
  - `loans`: One-to-many relationship with `Loan`.

- **Loan**:
  - `id`: Unique identifier (`cuid`).
  - `userId`: Foreign key referencing `User.id` (with `onDelete: Cascade`).
  - `friendName`: Friend's name (`VarChar(80)`).
  - `amount`: Principal amount stored as high-precision `Decimal(12, 2)` (NUMERIC in PostgreSQL; avoids JavaScript binary floating-point inaccuracy).
  - `dueDate`: Due date (`Date`).
  - `status`: Enum (`PENDING` or `REPAID`).
  - `createdAt`: Loan creation timestamp.
  - `updatedAt`: Auto-updating timestamp.
  - `repaidAt`: Optional timestamp when the loan was marked repaid.
  - `repayments`: One-to-many relationship with `Repayment`.
  - **Indexes**: Composite index on `(userId, status, dueDate)` and `(userId, createdAt)` for high-performance dashboard aggregations and queries.

- **Repayment**:
  - `id`: Unique identifier (`cuid`).
  - `loanId`: Foreign key referencing `Loan.id` (with `onDelete: Cascade`).
  - `amount`: Repayment amount (`Decimal(12, 2)`).
  - `repaidAt`: Repayment timestamp.
  - **Indexes**: Index on `loanId` and `repaidAt`.

---

## 🛠️ Local PostgreSQL Configuration

### Option A: Local Docker PostgreSQL (Recommended)
Run PostgreSQL locally using Docker:
```bash
docker run --name miniledger-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=miniledger \
  -p 5432:5432 -d postgres:16-alpine
```

Connection string for `backend/.env`:
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/miniledger?schema=public"
```

### Option B: Native PostgreSQL Installation
1. Start your local PostgreSQL service.
2. Create the database:
   ```bash
   createdb -U postgres miniledger
   ```
3. Update `backend/.env` with your local PostgreSQL user, password, and port.

### Option C: Cloud Hosted PostgreSQL (Supabase / Neon)
If using Supabase on an IPv4 network, use the **Session Connection Pooler** (port 5432):
```env
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```
*(Note: If your password contains `@`, encode it as `%40` in the URL).*

---

## 📜 Prisma Workflow Scripts

All Prisma operations are configured as standard npm scripts:

| Command | Action | Description |
| :--- | :--- | :--- |
| `npm run prisma:validate` | Validates Schema | Checks `prisma/schema.prisma` syntax and rules without touching the database. |
| `npm run prisma:generate` | Generates Client | Generates the strongly-typed Prisma Client in `node_modules/@prisma/client`. |
| `npm run prisma:migrate` | Dev Migration | Creates and applies a new migration in development (`prisma migrate dev`). |
| `npm run prisma:deploy` | Production Deploy | Applies pending migrations in CI/CD or production environments. |
| `npm run prisma:push` | Schema Sync | Prototyping tool to push schema changes directly to the database. |
| `npm run prisma:studio` | Database GUI | Launches Prisma Studio in your browser to inspect and edit database records. |

---

## 🚀 Getting Started

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your DATABASE_URL and JWT_SECRET
   ```

3. **Synchronize Database**:
   ```bash
   npm run prisma:generate
   npm run prisma:push
   # Or for formal migrations:
   # npm run prisma:migrate -- --name init
   ```

4. **Run Tests & Verification**:
   ```bash
   npm run build
   npm test
   ```

5. **Start Dev Server**:
   ```bash
   npm run dev
   ```
