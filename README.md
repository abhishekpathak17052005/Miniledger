# MiniLedger 💳

[![Backend Vitest](https://img.shields.io/badge/backend-56%20tests%20passing-brightgreen)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-blue.svg)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend)
[![Expo](https://img.shields.io/badge/Expo-v53-black)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/mobile)
[![Prisma](https://img.shields.io/badge/Prisma-ORM%20v6-indigo)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend/prisma)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-3ECF8E)](https://supabase.com)

A functional full-stack personal finance demo application built to track money lent to friends, attach receipt photos, monitor repayments, and automatically flag overdue debts in real-time using mock OTP authentication.

---

## 📑 Table of Contents
- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Authentication & Loan Lifecycle](#-authentication--loan-lifecycle)
- [Technology Stack](#-technology-stack)
- [Database Schema & Prisma Configuration](#-database-schema--prisma-configuration)
- [Environment Configuration](#-environment-configuration)
- [Local Setup & Getting Started](#-local-setup--getting-started)
- [Mock OTP & Receipt Demo Walkthrough](#-mock-otp--receipt-demo-walkthrough)
- [API Specification & Examples](#-api-specification--examples)
- [Core Financial & Overdue Business Rules](#-core-financial--overdue-business-rules)
- [Testing & Quality Verification](#-testing--quality-verification)
- [2–3 Minute Demo Recording Script](#-23-minute-demo-recording-script)
- [Known Limitations & Submission Notes](#-known-limitations--submission-notes)

---

## ✨ Key Features

1. **Passwordless Mock OTP Authentication**:
   - Clean login via 10-digit Indian mobile numbers (`/^[6-9]\d{9}$/`).
   - Cryptographically secure 6-digit OTP generated via Node.js `crypto.randomInt()`.
   - 60-second resend cooldown with HTTP 429 rate limiting and live countdown timer in the UI.
   - 5-minute time-to-live (TTL) and 5-attempt limit per verification window.
   - Mock OTP printed directly to backend terminal console (never exposed in API responses).

2. **Personal Lending Dashboard**:
   - Real-time financial summary card: **Total Lent**, **Outstanding Amount**, **Total Repaid**, and **Overdue Amount**.
   - Currency display formatted with Indian Rupee symbol (`₹`) and two-decimal precision.
   - Dynamic search filter and category tabs (`All`, `Pending`, `Overdue`, `Repaid`) with live record counts.

3. **Receipt Photo Attachment & Secure Private Storage**:
   - Attach receipt images directly from mobile photo gallery or web file selector.
   - Live image preview with file size details and one-tap removal before saving.
   - Attach or replace receipts on existing pending loans.
   - Strict file validation: JPEG, PNG, and WebP formats supported with binary magic bytes verification; 5MB size limit.
   - Private owner-scoped access: receipts are never public; only the loan's owner can view or download receipts via authenticated endpoints.
   - Storage provider abstraction: supports private Supabase Storage buckets or local private storage. No service keys exposed to client.

4. **High-Precision Financial Storage**:
   - Monetary values stored using PostgreSQL `Decimal(12,2)` (NUMERIC) to eliminate binary floating-point rounding errors.
   - Exact aggregation via Prisma Decimal arithmetic.

5. **Automated Overdue Debt Classification**:
   - Outstanding loans whose `dueDate` is strictly earlier than today UTC are dynamically flagged as overdue.
   - Highlighted in red with warning icons and visual badges.
   - Repaid loans are permanently immune to overdue status.

6. **Safe Repayment Execution**:
   - One-tap loan repayment with native confirmation prompt.
   - Per-loan busy spinner and button disablement preventing duplicate submissions or race conditions.
   - Immediate live recalculation of financial totals.

7. **Strict Multi-User Isolation**:
   - Every read, create, update, repayment, and receipt query is strictly scoped to the authenticated `req.userId` extracted from verified HS256 JWT tokens.
   - Cross-user access or repayment attempts return `404 Loan not found`.

---

## 🏛️ System Architecture

```mermaid
graph TD
    subgraph Mobile ["📱 Mobile Client (React Native + Expo SDK 53)"]
        UI[App UI / Dashboard]
        AuthStore[AsyncStorage JWT Token]
        Filter[Search & Status Filter]
        ReceiptPicker[ImagePicker + Preview]
        PlatformCfg[Dynamic Platform API Resolution]
    end

    subgraph API ["⚡ REST API Server (Node.js + Express + TypeScript)"]
        Router[Express Router & Helmet Security]
        AuthMid[requireAuth JWT Middleware: HS256]
        ZodVal[Zod Schema Validation Engine]
        OtpStore[In-Memory CSPRNG OTP Engine + Cooldown]
        StorageSvc[Receipt Storage Service & Magic Bytes]
        CalcEngine[Financial Calculation Engine]
    end

    subgraph Database ["🗄️ Database Layer (Supabase PostgreSQL)"]
        Prisma[Prisma Client v6]
        UserTable[Users Table]
        LoanTable[Loans Table: Decimal 12,2 + receiptPath]
        Indexes[Composite Indexes: userId, status, dueDate]
    end

    UI --> PlatformCfg
    PlatformCfg -->|HTTP / JSON| Router
    Router --> AuthMid
    AuthMid --> ZodVal
    ZodVal --> Prisma
    ZodVal --> StorageSvc
    Router --> OtpStore
    Router --> CalcEngine
    Prisma --> UserTable
    Prisma --> LoanTable
    LoanTable --> Indexes
```

---

## 🔁 Authentication & Loan Lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as Mobile User (App / Web)
    participant API as Express API (:4000)
    participant Console as Backend Terminal
    participant DB as Supabase PostgreSQL

    Note over User, API: 1. Phone + OTP Login Flow
    User->>API: POST /api/auth/request-otp { phone: "9876543210" }
    API->>Console: [MiniLedger OTP] Mobile: 9876543210 | Code: 467527
    API-->>User: 200 OK { message: "OTP generated", expiresInSeconds: 300 }
    Note over User: 60s cooldown timer starts in UI
    User->>API: POST /api/auth/verify-otp { phone: "9876543210", otp: "467527" }
    API->>DB: Upsert User (phone)
    DB-->>API: User record (id, phone)
    API-->>User: 200 OK { token: "JWT...", user: { id, phone } }
    User->>User: Store token in AsyncStorage

    Note over User, API: 2. Create Loan with Optional Receipt
    User->>API: POST /api/loans (Bearer JWT) { friendName: "Riya", amount: 1500, dueDate: "2026-11-15", receipt: {...} }
    API->>DB: INSERT INTO Loan (userId, friendName, amount, dueDate, PENDING, receiptPath)
    DB-->>API: Saved Loan Record
    API-->>User: 201 Created (hasReceipt: true)

    Note over User, API: 3. View Receipt (Owner Only)
    User->>API: GET /api/loans/:id/receipt?format=json (Bearer JWT)
    API->>DB: Verify ownership (userId == req.userId)
    API-->>User: 200 OK { url: "data:image/jpeg;base64,..." }

    Note over User, API: 4. Repayment Flow
    User->>API: PATCH /api/loans/:id/repay (Bearer JWT)
    API->>DB: Verify ownership & UPDATE status = REPAID
    DB-->>API: Updated Loan
    API-->>User: 200 OK (repaid)
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
| **Validation** | Zod 3.24 | Runtime payload parsing (phone numbers, amounts, dates, files) |
| **Security** | Helmet, CORS, JWT | Security headers, cross-origin rules, HS256-signed stateless tokens |
| **Automated Testing**| Vitest 3.0 + Supertest 7.0 | In-memory Prisma test doubles, 56 unit and integration tests |

---

## 🗄️ Database Schema & Prisma Configuration

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
  loans     Loan[]

  @@map("users")
}

enum LoanStatus {
  PENDING
  REPAID
}

model Loan {
  id                 String      @id @default(cuid())
  userId             String
  friendName         String      @db.VarChar(80)
  amount             Decimal     @db.Decimal(12, 2)
  dueDate            DateTime    @db.Date
  status             LoanStatus  @default(PENDING)
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @default(now()) @updatedAt
  repaidAt           DateTime?
  receiptPath        String?     @db.VarChar(255)
  receiptContentType String?     @db.VarChar(50)
  user               User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  repayments         Repayment[]

  @@index([userId, status, dueDate])
  @@index([userId, createdAt])
  @@map("loans")
}
```

### Key Schema Decisions:
- **`Decimal(12, 2)`**: Guarantees currency accuracy up to ₹9,999,999,999.99 without IEEE 754 floating point distortion.
- **`receiptPath` & `receiptContentType`**: Stores private storage reference and MIME type for receipt images.
- **Cascade Deletes**: If a user is deleted, all associated loan records are automatically cleaned up.
- **Composite Index `[userId, status, dueDate]`**: Optimizes multi-user summary queries, sorting, and overdue date filters.

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

# Optional: Supabase Storage Configuration (if using a private Supabase bucket for receipts)
# If omitted, receipts are stored securely in local private storage (uploads/receipts/)
# SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
# SUPABASE_SERVICE_ROLE_KEY="your-supabase-service-role-key"
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

> [!NOTE]
> When `EXPO_PUBLIC_API_URL` is not set, `App.tsx` automatically resolves to `http://10.0.2.2:4000` on Android devices and `http://localhost:4000` on Web and iOS.

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

## 📲 Mock OTP & Receipt Demo Walkthrough

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
7. The dashboard loads your user-scoped loans and financial totals.
8. **Add an active loan with receipt photo**:
   - Tap **+ Add Loan**, enter friend name `Riya Sharma`, amount `1500`, tap preset `+7 Days`.
   - Tap **📷 Choose Receipt Photo** and select an image file. Preview appears with thumbnail and file size.
   - Tap **Save Loan**. Notice the card appears with a **📷 Receipt** badge, and dashboard totals update by ₹1,500.00.
   - Tap **📷 Receipt** on the card to open the secure receipt viewer modal.
9. **Demonstrate overdue detection**:
   - Tap **+ Add Loan**, enter friend name `Aman Verma`, amount `800`, and set the due date to **yesterday's date** (e.g. `2026-10-22`).
   - Tap **Save Loan**. The card is immediately highlighted in soft red with a `● Overdue` badge and warning text, and the **Overdue Amount** summary updates to ₹800.00.
10. **Demonstrate safe repayment**:
    - Tap **Mark Repaid** on the first loan, confirm the dialog.
    - The status changes to `✓ Repaid`, **Total Repaid** increases by ₹1,500.00, and **Outstanding** decreases accordingly.

---

## 📋 API Specification & Examples

Base URL: `http://localhost:4000`

### 1. Health Check
- **Endpoint**: `GET /api/health`
- **Response**: `200 OK`

### 2. Request Mock OTP
- **Endpoint**: `POST /api/auth/request-otp` *(alias: `/api/auth/send-otp`)*
- **Body**: `{ "phone": "9876543210" }`
- **Response**: `200 OK`

### 3. Verify OTP & Obtain JWT
- **Endpoint**: `POST /api/auth/verify-otp`
- **Body**: `{ "phone": "9876543210", "otp": "582194" }`
- **Response**: `200 OK` (`{ token, user }`)

### 4. List Loans
- **Endpoint**: `GET /api/loans`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK` (Array of user-scoped loans with `hasReceipt` and `receiptUrl`)

### 5. Create a Loan (with optional receipt)
- **Endpoint**: `POST /api/loans`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Body**:
```json
{
  "friendName": "Riya Sharma",
  "amount": 1500,
  "dueDate": "2026-11-15",
  "receipt": {
    "imageBase64": "base64-encoded-string...",
    "contentType": "image/jpeg"
  }
}
```
- **Response**: `201 Created`

### 6. Attach Receipt to Existing Loan
- **Endpoint**: `POST /api/loans/:id/receipt`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Body**: `{ "imageBase64": "...", "contentType": "image/jpeg" }`
- **Response**: `200 OK` (Updated loan object)

### 7. View / Download Receipt (Owner Only)
- **Endpoint**: `GET /api/loans/:id/receipt`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Query**: `?format=json` returns `{ url: "data:image/jpeg;base64,..." }`
- **Direct**: Serves image stream with `Content-Type: image/jpeg` and `Cache-Control: private`
- **Cross-User Protection**: Returns `404 Not Found` if the loan belongs to another user.

### 8. Delete Receipt
- **Endpoint**: `DELETE /api/loans/:id/receipt`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK` (Loan object with `receiptPath: null`)

### 9. Custom Overdue Amount Override
- **Endpoint**: `PATCH /api/loans/:id/overdue`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Body**: `{ "customOverdueAmount": 1250.00 }` (or `null` to reset to original loan amount)
- **Response**: `200 OK` (Updated loan object with `customOverdueAmount`)
- **Use Case**: Allows setting a customized overdue amount (e.g., adding late fee, penalty, or recording a negotiated amount).

### 10. Repay a Loan
- **Endpoint**: `PATCH /api/loans/:id/repay`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK`

### 11. Financial Summary
- **Endpoint**: `GET /api/loans/summary`
- **Headers**: `Authorization: Bearer <TOKEN>`
- **Response**: `200 OK` (`{ totalLent, totalRepaid, overdueAmount, outstandingAmount }`)

---

## 💰 Core Financial & Overdue Business Rules

1. **Precision Rule**: Amounts are manipulated and stored via `Decimal` types, preventing `0.1 + 0.2 = 0.30000000000000004` errors.
2. **Total Lent**: Sum of all loans created by the authenticated user (`PENDING` + `REPAID`).
3. **Total Repaid**: Sum of all loans where `status = "REPAID"`.
4. **Outstanding Amount**: Exactly `Total Lent - Total Repaid`.
5. **Overdue Calculation**: Any loan where `status = "PENDING"` AND `dueDate < startOfTodayUTC`. Overdue loans default to their full `amount`, or their `customOverdueAmount` if manually set.
6. **Due Today Rule**: A loan due today is **not** overdue; it remains in pending status until the day expires.
7. **Repaid Immunity**: Loans marked `REPAID` are permanently excluded from overdue totals, regardless of how far in the past their `dueDate` falls.
8. **Custom Overdue Override**: Users can manually set or clear a custom overdue amount per loan via `PATCH /api/loans/:id/overdue` or in the Add Loan form.

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
*Expected: 62/62 tests passing across unit, middleware, auth, loans, receipt storage, and overdue suites.*

### Test Suite Breakdown:
- **API Health & Unknown Routes**: 2 tests.
- **Phone Validation & OTP Generation**: 8 tests (Indian phone patterns, 60s cooldown, CSPRNG, prod log suppression).
- **OTP Verification & User Upsert**: 7 tests (expiry, single-use enforcement, 5-attempt limit, timing-safe equality).
- **JWT Middleware**: 5 tests (missing token, invalid token, algorithm restrictions, ghost user rejection).
- **Loan Creation Validation**: 7 tests (name length, positive amount, 2 decimals max, valid calendar dates).
- **Loan Listing & Multi-User Isolation**: 2 tests (scoped lists, user B isolation).
- **Loan Repayment Security**: 4 tests (successful repay, invalid ID, cross-user 404, repeat 409).
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
| **0:00 – 0:25** | **Introduction & Architecture** | • Welcome the viewer to **MiniLedger**, a functional full-stack personal loan tracking demo application using mock OTP authentication.<br>• Briefly highlight the stack: React Native (Expo), Express, TypeScript, and Supabase PostgreSQL with Prisma ORM. |
| **0:25 – 0:55** | **Mock OTP Login & Terminal Verification** | • Enter phone number `9876543210` and click **Send Mock OTP**.<br>• Switch to the backend terminal console to show that the 6-digit OTP code is logged directly to stdout for testing.<br>• Point out the live **60-second cooldown timer** on the Resend button (`Resend OTP in 58s`).<br>• Enter the 6-digit OTP code and click **Verify & Log In** to reach the dashboard. |
| **0:55 – 1:30** | **Financial Summary Card & Add Loan with Receipt** | • Highlight the summary card showing Total Lent, Outstanding, Repaid, and Overdue.<br>• Click **+ Add Loan**.<br>• Enter friend's name (e.g., `Riya Sharma`), amount `1500`, and select preset `+7 Days`.<br>• Click **📷 Choose Receipt Photo**, select an image, show the thumbnail preview and file size.<br>• Click **Save Loan**; show instant dashboard summary update and the new loan card displaying the **📷 Receipt** badge.<br>• Click **📷 Receipt** on the card to open the secure receipt modal viewer. |
| **1:30 – 1:55** | **Overdue Detection with Past Due Date** | • Click **+ Add Loan** again and enter friend's name (e.g., `Aman Verma`), amount `800`, and enter **yesterday's date** (e.g., `2026-10-22`).<br>• Save the loan and observe that it is immediately classified as **Overdue** (highlighted in soft red with a ⚠️ warning badge).<br>• Point out that the hero summary's **Overdue Amount** increases by ₹800.00 while the repaid loan remains unaffected.<br>• Click the **Overdue** filter tab to demonstrate instant category filtering and search. |
| **1:55 – 2:20** | **Safe Repayment Flow & Live Balance Update** | • Click **Mark Repaid** on the first pending loan.<br>• Show the native confirmation modal and tap **Confirm Repay**.<br>• Observe the card badge switch to `✓ Repaid` and watch the financial hero card recalculate (Repaid increases, Outstanding decreases). |
| **2:20 – 2:40** | **Multi-User Security & Conclusion** | • Mention that all queries and receipts are strictly scoped to `req.userId` with HS256 JWT tokens.<br>• Highlight the 56 passing automated tests covering all edge cases, storage validations, and financial precision.<br>• Conclude the demonstration. |

---

## 📌 Known Limitations & Submission Notes

1. **SMS Gateway Simulation**:
   - For this internship assignment evaluation, OTPs are printed to the backend terminal rather than delivered via commercial SMS aggregators (e.g., Twilio or AWS SNS).
2. **Device Testing Environment**:
   - The frontend was verified in this session via **Expo Web** (`http://localhost:8081`).
   - Physical device or native emulator runs require configuring `EXPO_PUBLIC_API_URL` to the computer's Wi-Fi IP or Android emulator loopback (`10.0.2.2`).
3. **No Secrets in Version Control**:
   - All real connection strings, Supabase keys, and JWT secrets are strictly managed in local `.env` files and excluded from git commits via `.gitignore`.
