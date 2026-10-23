# MiniLedger 💳

[![Backend Vitest](https://img.shields.io/badge/backend-75%20tests%20passing-brightgreen)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-blue.svg)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend)
[![Expo](https://img.shields.io/badge/Expo-v53-black)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/mobile)
[![Prisma](https://img.shields.io/badge/Prisma-ORM%20v6-indigo)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend/prisma)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-3ECF8E)](https://supabase.com)

A functional full-stack personal finance application built to transform flat loan tracking into a friend-centric lending ledger. Manage reusable friend profiles, inspect detailed lending and repayment histories, record partial repayments, attach receipt photos, monitor debts, and flag overdue balances using mock OTP authentication.

---

## 📑 Table of Contents
- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Friend Profiles & Repayment Lifecycle](#-friend-profiles--repayment-lifecycle)
- [Technology Stack](#-technology-stack)
- [Database Schema & Migration Safety](#-database-schema--migration-safety)
- [Environment Configuration](#-environment-configuration)
- [Local Setup & Getting Started](#-local-setup--getting-started)
- [Demo Walkthrough](#-demo-walkthrough)
- [API Specification & Examples](#-api-specification--examples)
- [Core Financial & Overdue Business Rules](#-core-financial--overdue-business-rules)
- [Testing & Quality Verification](#-testing--quality-verification)
- [2–3 Minute Demo Recording Script](#-23-minute-demo-recording-script)
- [Known Limitations & Submission Notes](#-known-limitations--submission-notes)

---

## ✨ Key Features

1. **Friend Profiles & Duplicate Prevention Engine**:
   - Reusable `Friend` entities owned by the authenticated user, linking all loans to a single profile.
   - Whitespace and case-insensitive name matching (`normalizedName`) and digits-only phone normalization (`normalizedPhone`).
   - Duplicate prevention: attempting to create an already-existing friend returns HTTP `409 Conflict` with matching profiles so the user can select an existing friend or resolve ambiguities without silent data corruption.
   - Searchable friend selector in the Add Loan panel displaying current outstanding balances.

2. **Dedicated Friend Profile Screen**:
   - Comprehensive friend-level financial metrics: **Total Lent**, **Total Repaid**, **Outstanding Balance**, and **Overdue Amount**.
   - Chronological unified timeline displaying all loans and partial repayments for that friend.
   - Per-loan badges, due dates, receipt indicators, and overdue warnings.
   - Direct "+ Lend More" quick action that pre-selects the friend.

3. **Recorded Partial & Full Repayments**:
   - First-class `Repayment` transactions: records amount received, repayment timestamp, loan ID, and optional note (e.g. "UPI installment").
   - Atomic database `$transaction` ensuring repayments and loan status updates succeed or fail together.
   - Partial repayments allowed with remaining balance recalculation; loans automatically transition to `REPAID` when balance reaches zero.
   - Overpayment protection: strictly rejects repayments exceeding the remaining outstanding amount.
   - Full backward compatibility: `PATCH /api/loans/:id/repay` continues to work seamlessly alongside `POST /api/loans/:id/repayments`.

4. **Passwordless Mock OTP Authentication**:
   - Clean login via 10-digit Indian mobile numbers (`/^[6-9]\d{9}$/`).
   - Cryptographically secure 6-digit OTP generated via Node.js `crypto.randomInt()`.
   - 60-second resend cooldown with HTTP 429 rate limiting and live countdown timer in the UI.
   - 5-minute time-to-live (TTL) and 5-attempt limit per verification window.
   - Mock OTP printed directly to backend terminal console (never exposed in API responses).

5. **Personal Lending Dashboard**:
   - Real-time global financial summary card: **Total Lent**, **Outstanding Amount**, **Total Repaid**, and **Overdue Amount**.
   - Currency display formatted with Indian Rupee symbol (`₹`) and two-decimal precision.
   - Dynamic search filter and category tabs (`All`, `Pending`, `Overdue`, `Repaid`) with live record counts.

6. **Receipt Photo Attachment & Secure Private Storage**:
   - Attach receipt images directly from mobile photo gallery or web file selector.
   - Live image preview with file size details and one-tap removal before saving.
   - Strict file validation: JPEG, PNG, and WebP formats supported with binary magic bytes verification; 5MB size limit.
   - Private owner-scoped access: receipts are never public; only the loan's owner can view or download receipts via authenticated endpoints.

7. **High-Precision Financial Storage**:
   - Monetary values stored using PostgreSQL `Decimal(12,2)` (NUMERIC) to eliminate binary floating-point rounding errors.
   - Exact aggregation via Prisma Decimal arithmetic.

8. **Automated Overdue Debt Classification**:
   - Outstanding loans whose `dueDate` is strictly earlier than today UTC are dynamically flagged as overdue.
   - Highlighted in red with warning icons and visual badges.
   - Fully repaid loans are permanently immune to overdue status.

9. **Strict Multi-User Isolation**:
   - Every read, create, update, repayment, friend profile, and receipt query is strictly scoped to the authenticated `req.userId` extracted from verified HS256 JWT tokens.
   - Cross-user access or repayment attempts return `404 Not Found`.

---

## 🏛️ System Architecture

```mermaid
graph TD
    subgraph Mobile ["📱 Mobile Client (React Native + Expo SDK 53)"]
        UI[App UI / Dashboard]
        FriendPicker[Searchable Friend Selector]
        FriendModal[Friend Profile Modal & Timeline]
        RepayModal[Repayment Recorder Modal]
        AuthStore[AsyncStorage JWT Token]
        ReceiptPicker[ImagePicker + Preview]
    end

    subgraph API ["⚡ REST API Server (Node.js + Express + TypeScript)"]
        Router[Express Router & Helmet Security]
        AuthMid[requireAuth JWT Middleware: HS256]
        ZodVal[Zod Schema Validation Engine]
        OtpStore[In-Memory CSPRNG OTP Engine + Cooldown]
        StorageSvc[Receipt Storage Service & Magic Bytes]
        TxEngine[Atomic Prisma Transactions]
        CalcEngine[Financial Calculation Engine]
    end

    subgraph Database ["🗄️ Database Layer (Supabase PostgreSQL)"]
        UserTable[Users Table]
        FriendTable[Friends Table: normalizedName, normalizedPhone]
        LoanTable[Loans Table: Decimal 12,2 + friendId + receiptPath]
        RepaymentTable[Repayments Table: amount, loanId, note]
        Indexes[Composite Indexes: userId, friendId, status, dueDate]
    end

    UI --> FriendPicker
    UI --> FriendModal
    UI --> RepayModal
    UI -->|HTTP / JSON| Router
    Router --> AuthMid
    AuthMid --> ZodVal
    ZodVal --> TxEngine
    TxEngine --> FriendTable
    TxEngine --> LoanTable
    TxEngine --> RepaymentTable
    ZodVal --> StorageSvc
    Router --> OtpStore
    Router --> CalcEngine
    UserTable --> FriendTable
    FriendTable --> LoanTable
    LoanTable --> RepaymentTable
```

---

## 🔁 Friend Profiles & Repayment Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as Mobile User (App / Web)
    participant API as Express API (:4000)
    participant DB as Supabase PostgreSQL

    Note over User, API: 1. Create or Select Friend Profile
    User->>API: POST /api/friends { name: "Pooja Verma", phone: "+91 91234 56789" }
    API->>DB: Check duplicates by normalizedName & normalizedPhone
    alt Friend already exists
        API-->>User: 409 Conflict { message: "Friend profile already exists", existingFriends: [...] }
    else New Friend
        API->>DB: INSERT INTO Friend (userId, name, normalizedName, phone, normalizedPhone)
        DB-->>API: Created Friend Record
        API-->>User: 201 Created { id, name, phone, ... }
    end

    Note over User, API: 2. Create Loan under Friend Profile
    User->>API: POST /api/loans { friendId: "f_123", amount: 3000, dueDate: "2026-11-15" }
    API->>DB: Verify friend ownership & INSERT Loan (friendId, userId, amount, dueDate, PENDING)
    DB-->>API: Saved Loan Record
    API-->>User: 201 Created

    Note over User, API: 3. Record Partial Repayment with Note
    User->>API: POST /api/loans/:id/repayments { amount: 1000, note: "UPI partial payment" }
    API->>DB: BEGIN TRANSACTION
    API->>DB: Verify loan ownership and calculate outstanding balance
    alt Repayment amount > outstanding balance
        API-->>User: 400 Bad Request { error: "Repayment amount exceeds outstanding balance" }
    else Valid repayment
        API->>DB: INSERT INTO Repayment (loanId, amount, note)
        API->>DB: Update Loan (if balance == 0 -> REPAID, else PENDING)
        API->>DB: COMMIT TRANSACTION
        API-->>User: 201 Created { repayment, loan: { remainingAmount: 2000, status: "PENDING" } }
    end

    Note over User, API: 4. Inspect Detailed Friend Profile
    User->>API: GET /api/friends/:id
    API->>DB: Query Friend + Loans + Repayments (scoped to req.userId)
    DB-->>API: Aggregated loans & repayments
    API-->>User: 200 OK { friend, totalLent, totalRepaid, outstandingAmount, loans: [...] }
```

---

## 🛠️ Technology Stack

| Layer | Technology | Details / Purpose |
| :--- | :--- | :--- |
| **Mobile Frontend** | React Native 0.79.5 | Component rendering across Web, Android, and iOS |
| **Mobile Toolchain** | Expo SDK 53 | Bundler, dev server, instant browser preview via `react-native-web` |
| **Image Selection** | `expo-image-picker` ~16.0 | Gallery and file picker with preview and base64 encoding |
| **Local Storage** | `@react-native-async-storage/async-storage` | Client-side JWT token and user session persistence |
| **API Server** | Node.js + Express 4.21 | RESTful routing, asynchronous middleware pipeline |
| **Language** | TypeScript 5.7+ / 5.8+ | Strict type safety across client and server codebases |
| **Database** | PostgreSQL (Supabase) | Cloud relational storage with ACID compliance and session pooler |
| **ORM** | Prisma ORM 6.19 | Declarative schema, migrations, type-safe query generation |
| **Validation** | Zod 3.24 | Runtime payload parsing (friends, loans, repayments, files) |
| **Security** | Helmet, CORS, JWT | Security headers, cross-origin rules, HS256-signed stateless tokens |
| **Automated Testing**| Vitest 3.0 + Supertest 7.0 | In-memory Prisma test doubles, 75 unit and integration tests |

---

## 🗄️ Database Schema & Migration Safety

The database schema is defined in [backend/prisma/schema.prisma](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend/prisma/schema.prisma):

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id        String   @id @default(cuid())
  phone     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  friends   Friend[]
  loans     Loan[]

  @@map("users")
}

model Friend {
  id              String   @id @default(cuid())
  userId          String
  name            String   @db.VarChar(80)
  normalizedName  String   @db.VarChar(80)
  phone           String?  @db.VarChar(20)
  normalizedPhone String?  @db.VarChar(20)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @default(now()) @updatedAt
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  loans           Loan[]

  @@index([userId, normalizedName])
  @@index([userId, normalizedPhone])
  @@map("friends")
}

enum LoanStatus {
  PENDING
  REPAID
}

model Loan {
  id                  String      @id @default(cuid())
  userId              String
  friendId            String?
  friendName          String      @db.VarChar(80)
  amount              Decimal     @db.Decimal(12, 2)
  dueDate             DateTime    @db.Date
  status              LoanStatus  @default(PENDING)
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @default(now()) @updatedAt
  repaidAt            DateTime?
  receiptPath         String?     @db.VarChar(255)
  receiptContentType  String?     @db.VarChar(50)
  customOverdueAmount Decimal?    @db.Decimal(12, 2)
  user                User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  friend              Friend?     @relation(fields: [friendId], references: [id], onDelete: SetNull)
  repayments          Repayment[]

  @@index([userId, status, dueDate])
  @@index([userId, createdAt])
  @@index([userId, friendId])
  @@map("loans")
}

model Repayment {
  id        String   @id @default(cuid())
  loanId    String
  amount    Decimal  @db.Decimal(12, 2)
  paidAt    DateTime @default(now())
  note      String?  @db.VarChar(255)
  loan      Loan     @relation(fields: [loanId], references: [id], onDelete: Cascade)

  @@index([loanId, paidAt])
  @@map("repayments")
}
```

### Safe Backward-Compatible Migration Plan:
1. **Zero Data Deletion**: Live database records (users, loans, repayments, receipts) are never dropped or recreated.
2. **Backfill Phase**: Existing loans created before Phase 8 were safely migrated by grouping existing `(userId, friendName)` pairs, automatically creating corresponding `Friend` records, and populating `friendId` on every historical loan.
3. **Foreign Key Safety**: `Loan.friendId` is linked with `onDelete: SetNull` and indexed on `[userId, friendId]` to maintain referential integrity.
4. **Prisma Migration**: The complete DDL and backfill script is preserved under `backend/prisma/migrations/20261023190000_friend_profiles/migration.sql`.

---

## ⚙️ Environment Configuration

### Backend: `backend/.env`
Copy `backend/.env.example` to `backend/.env`:
```bash
cd backend
cp .env.example .env
```
Contents:
```env
# Supabase PostgreSQL connection string (IPv4 session pooler recommended for local development)
DATABASE_URL="postgresql://postgres.YOUR_PROJECT_REF:YOUR_PASSWORD@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres"

# Cryptographically strong JWT secret (at least 32 characters)
JWT_SECRET="replace-with-a-long-random-secret-at-least-32-characters"

PORT=4000
NODE_ENV=development
```

### Mobile: `mobile/.env`
Copy `mobile/.env.example` to `mobile/.env`:
```bash
cd mobile
cp .env.example .env
```
Contents:
```env
# 1. Web browser & iOS Simulator:
EXPO_PUBLIC_API_URL=http://localhost:4000

# 2. Android Emulator (accesses host computer via 10.0.2.2):
# EXPO_PUBLIC_API_URL=http://10.0.2.2:4000

# 3. Physical Device running Expo Go (use your computer's Wi-Fi LAN IP):
# EXPO_PUBLIC_API_URL=http://192.168.1.XX:4000
```

---

## 🚀 Local Setup & Getting Started

### Prerequisites
- **Node.js**: v20 or v22 LTS
- **npm**: v10+
- **PostgreSQL**: Supabase account or local PostgreSQL instance

### 1. Start the Backend API Server
```bash
cd backend
npm install
npm run prisma:generate
npm run dev
```
- API server will start on: **`http://localhost:4000`**
- Health check available at: **`http://localhost:4000/api/health`**

### 2. Start the Mobile Client
```bash
cd mobile
npm install
npx expo start --web
```
- Expo Web dashboard will launch on: **`http://localhost:8081`**

---

## 📲 Demo Walkthrough

1. Open **`http://localhost:8081`** in your browser.
2. Enter any 10-digit Indian phone number (e.g., `9876543210`).
3. Click **Send Mock OTP**.
4. Check your backend terminal console. In this demo setup, OTP codes are logged directly to stdout:
   ```text
   ======================================================
   [MiniLedger OTP] Mobile: 9876543210 | Code: 582194 (Valid for 5m)
   ======================================================
   ```
5. Observe the live **60-second cooldown timer** on the Resend button (`Resend OTP in 59s...`).
6. Enter the 6-digit code in the OTP field and tap **Verify & Log In**.
7. The dashboard loads your user-scoped friends and financial totals.
8. **Main screen — one entry per friend**:
   - Each friend profile is shown exactly once as a rich card.
   - Each card displays their name, optional phone, total loans count, outstanding balance, overdue amount (if any), and latest activity date.
   - Use the category filter chips (`All`, `Outstanding`, `Overdue`, `Settled`) and search bar to filter friends instantly.
9. **Add a loan with friend selection**:
   - Tap **+ Add Loan**.
   - Notice the searchable friend selector displaying existing friends with their current balances.
   - Choose an existing friend, or enter a new friend's name and optional phone.
   - Enter amount `3000`, tap preset `+7 Days`, and tap **Save Loan**.
10. **Open Friend Detail Screen & Complete History**:
    - Tap any friend card on the dashboard to open their full **Friend Detail** modal screen.
    - View friend-level summary: Total Lent, Total Repaid, Outstanding Balance, and Overdue Amount.
    - Inspect the chronological timeline of all loans and repayment transactions.
    - Tap **+ Add Loan to [Friend]** to record another loan directly under this same friend profile.
11. **Record a Partial Repayment**:
    - Under the pending loan, tap **Record Repay**.
    - Enter `1000` and note `UPI payment 1st installment`.
    - Tap **Submit Repayment**.
    - Observe that the loan remains in `PENDING` status with remaining balance `₹2,000.00`, the repayment is recorded in the timeline with its timestamp and note, and the dashboard summary immediately reflects `₹1,000.00` repaid.
12. **Test Overpayment Prevention**:
    - Try to record a repayment exceeding remaining balance. Notice the system blocks overpayments with a clear alert.
13. **Complete Full Repayment**:
    - Tap **Full Repay** or submit the remaining balance.
    - The loan automatically transitions to `✓ Repaid`, remaining balance becomes `₹0.00`, and all prior payment records remain preserved in the audit trail.

---

## 📋 API Specification & Examples

Base URL: `http://localhost:4000`

### 1. Friend Endpoints

#### List Friends
- **Endpoint**: `GET /api/friends?search=Pooja`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK`
```json
[
  {
    "id": "cmvl4k3cq0001v0d8iwhj8c27",
    "name": "Pooja Verma",
    "phone": "+91 91234 56789",
    "totalLent": 3000,
    "totalRepaid": 1000,
    "outstandingAmount": 2000,
    "overdueAmount": 0,
    "activeLoansCount": 1
  }
]
```

#### Create Friend
- **Endpoint**: `POST /api/friends`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Body**:
```json
{
  "name": "Pooja Verma",
  "phone": "+91 91234 56789"
}
```
- **Duplicate Response**: `409 Conflict`
```json
{
  "error": "A friend with this name or phone already exists",
  "existingFriends": [{ "id": "...", "name": "Pooja Verma" }]
}
```

#### Get Friend Profile
- **Endpoint**: `GET /api/friends/:id`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK` (Profile with full loan list, repayment history, and aggregated balances)

---

### 2. Loan Endpoints

#### Create Loan
- **Endpoint**: `POST /api/loans`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Body**:
```json
{
  "friendId": "cmvl4k3cq0001v0d8iwhj8c27",
  "amount": 3000,
  "dueDate": "2026-11-15",
  "receipt": {
    "imageBase64": "...",
    "contentType": "image/jpeg"
  }
}
```
- **Response**: `201 Created`

#### List Loans
- **Endpoint**: `GET /api/loans`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK` (Array of user-scoped loans with `friendId`, `friendName`, `repaidAmount`, `remainingAmount`, and `repayments`)

#### Record Repayment
- **Endpoint**: `POST /api/loans/:id/repayments`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Body**:
```json
{
  "amount": 1000.00,
  "note": "UPI installment"
}
```
- **Response**: `201 Created`
```json
{
  "repayment": { "id": "...", "amount": "1000.00", "note": "UPI installment", "paidAt": "..." },
  "loan": { "id": "...", "status": "PENDING", "remainingAmount": 2000.00 }
}
```

#### Mark Full Repayment (Legacy Compatible)
- **Endpoint**: `PATCH /api/loans/:id/repay`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK`

---

## 💰 Core Financial & Overdue Business Rules

1. **Precision Rule**: Amounts are manipulated and stored via `Decimal` types, preventing `0.1 + 0.2 = 0.30000000000000004` errors.
2. **Total Lent**: Sum of all loans created by the authenticated user (`PENDING` + `REPAID`).
3. **Total Repaid**: Sum of all recorded repayment transactions associated with the user's loans.
4. **Outstanding Amount**: Exactly `Total Lent - Total Repaid`.
5. **Overdue Calculation**: Any loan where `status = "PENDING"` AND `dueDate < startOfTodayUTC`. Overdue loans default to their remaining outstanding balance, or their `customOverdueAmount` if manually set.
6. **Due Today Rule**: A loan due today is **not** overdue; it remains in pending status until the day expires.
7. **Repaid Immunity**: Loans marked `REPAID` are permanently excluded from overdue totals, regardless of how far in the past their `dueDate` falls.

---

## 🧪 Testing & Quality Verification

### Run Mobile TypeScript Typecheck
```bash
cd mobile
npm run typecheck
```
*Expected: 0 errors.*

### Run Backend Validations, Build & Test Suite
```bash
cd backend
npm run prisma:validate
npm run build
npm test
```
*Expected: 75/75 tests passing across unit, middleware, auth, loans, friend profiles, repayment transactions, receipt storage, and overdue suites.*

### Test Suite Breakdown:
- **API Health & Unknown Routes**: 2 tests.
- **Phone Validation & OTP Generation**: 8 tests (Indian phone patterns, 60s cooldown, CSPRNG, prod log suppression).
- **OTP Verification & User Upsert**: 7 tests (expiry, single-use enforcement, 5-attempt limit, timing-safe equality).
- **JWT Middleware**: 5 tests (missing token, invalid token, algorithm restrictions, ghost user rejection).
- **Friend Profiles & Duplicate Prevention**: 8 tests (create friend, normalize whitespace/case, duplicate 409 conflict, list friends with balances, friend profile details, cross-user 404).
- **Loan Creation Validation & Friend Association**: 8 tests (name length, positive amount, 2 decimals max, valid calendar dates, friendId association, cross-user friendId rejection).
- **Recorded Repayments & Balance Precision**: 5 tests (partial repayment, multi-installment transition to REPAID, overpayment rejection, repayment notes audit trail, cross-user repayment rejection).
- **Loan Listing & Multi-User Isolation**: 2 tests (scoped lists, user B isolation).
- **Summary Calculations & Overdue Semantics**: 6 tests (zero loans, Decimal precision, due today, repaid immunity, custom overdue summary reflection, pure logic).
- **Receipt Storage & Image Validation**: 7 tests (JPEG/PNG/WebP magic bytes, non-image rejection, 5MB limit, disk storage lifecycle).
- **Receipt API Endpoints & Security**: 9 tests (MIME type restrictions, corrupted magic byte rejection, cross-user attachment 404, cross-user view 404, unauthenticated 401, attach to existing, serve image, JSON data URL format, delete receipt).
- **Custom Overdue Amount API**: 5 tests (update custom overdue, clear with null, Bob cross-user 404, validation errors on negative/decimal, pure calculation logic).

---

## 🎥 2–3 Minute Demo Recording Script

### Pre-Recording Setup:
1. Ensure the backend server is running in terminal 1: `cd backend && npm run dev`.
2. Ensure Expo Web is running in terminal 2: `cd mobile && npx expo start --web`.
3. Clear `miniledger_token` from browser LocalStorage or use an Incognito tab at `http://localhost:8081`.

### Recording Timeline:

| Timestamp | Screen / Flow | Action & Narration |
| :--- | :--- | :--- |
| **0:00 – 0:25** | **Introduction & Architecture** | • Welcome the viewer to **MiniLedger**, now upgraded to a friend-centric lending tracker.<br>• Briefly highlight the stack: React Native (Expo SDK 53), Express, TypeScript, and Supabase PostgreSQL with Prisma ORM. |
| **0:25 – 0:50** | **Mock OTP Login** | • Enter phone number `9876543210` and click **Send Mock OTP**.<br>• Check the backend terminal console to show the 6-digit OTP code.<br>• Enter the code and click **Verify & Log In** to reach the dashboard. |
| **0:50 – 1:25** | **Friend Profiles & Add Loan** | • Click **+ Add Loan**.<br>• Show the searchable friend picker displaying current balances.<br>• Add a new friend `Pooja Verma` with phone number, select preset `+7 Days`, and save the loan.<br>• Demonstrate duplicate prevention: trying to add the same friend again warns with a duplicate conflict modal allowing direct profile selection. |
| **1:25 – 1:55** | **Friend Profile Screen & Timeline** | • Tap Pooja Verma's name badge on the loan card.<br>• Show the Friend Profile modal: Total Lent, Total Repaid, Outstanding Balance, Overdue Amount, and the chronological timeline.<br>• Point out the "+ Lend More" button. |
| **1:55 – 2:25** | **Recorded Partial Repayments & Overpayment Block** | • On the loan card, tap **Record Repay**.<br>• Try to enter an amount larger than outstanding debt to show the overpayment prevention error.<br>• Enter a partial repayment of ₹1,000 with a note `UPI installment 1`.<br>• Show the loan balance update to ₹2,000 remaining, and the payment entry appearing in the friend's timeline. |
| **2:25 – 2:45** | **Receipt Viewer & Overdue Highlighting** | • Show an overdue loan highlighted in red with warning badges.<br>• Open a loan receipt photo in the secure private viewer modal.<br>• Conclude by highlighting the 75 passing automated tests and strict multi-user data isolation. |

---

## 📌 Known Limitations & Submission Notes

1. **SMS Gateway Simulation**:
   - For this internship assignment evaluation, OTPs are printed to the backend terminal rather than delivered via commercial SMS aggregators (e.g., Twilio or AWS SNS).
2. **Device Testing Environment**:
   - The frontend was verified in this session via **Expo Web** (`http://localhost:8081`).
   - Physical device or native emulator runs require configuring `EXPO_PUBLIC_API_URL` to the computer's Wi-Fi IP or Android emulator loopback (`10.0.2.2`).
3. **No Secrets in Version Control**:
   - All real connection strings, Supabase keys, and JWT secrets are strictly managed in local `.env` files and excluded from git commits via `.gitignore`.

