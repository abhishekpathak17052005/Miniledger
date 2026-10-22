# MiniLedger 💳

[![Backend Vitest](https://img.shields.io/badge/backend-15%20tests%20passing-brightgreen)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend)
[![Expo](https://img.shields.io/badge/Expo-v53-black)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/mobile)
[![Prisma](https://img.shields.io/badge/Prisma-ORM%20v6-indigo)](file:///c:/Users/Lenovo/Desktop/Projects/miniledger-starter/backend/prisma)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon%20Cloud-336791)](https://neon.tech)

A production-ready full-stack mobile application to track money lent to friends, monitor repayments, and automatically flag overdue debts in real-time.

---

## 🏛️ System Architecture

```mermaid
graph TD
    subgraph Mobile ["📱 Mobile Client (React Native + Expo)"]
        UI[App UI / Dashboard]
        AuthStore[AsyncStorage JWT Token]
        Filter[Search & Status Filter]
    end

    subgraph API ["⚡ REST API (Node.js + Express + TypeScript)"]
        Router[Express Router & Helmet]
        AuthMid[requireAuth JWT Middleware]
        ZodVal[Zod Schema Validation]
        OtpStore[In-Memory OTP Store]
        CalcEngine[Financial Calculation Engine]
    end

    subgraph Database ["🗄️ Database Layer (Neon PostgreSQL)"]
        Prisma[Prisma ORM Client]
        UserTable[Users Table]
        LoanTable[Loans Table: NUMERIC 12,2]
        Indexes[Composite Indexes: userId, status, dueDate]
    end

    UI -->|HTTP Requests| Router
    Router --> AuthMid
    AuthMid --> ZodVal
    ZodVal --> Prisma
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
    actor User as Abhishek (Mobile App)
    participant API as Express API (:4000)
    participant Console as Terminal Console
    participant DB as Neon PostgreSQL

    Note over User, API: 1. Phone + OTP Login Flow
    User->>API: POST /api/auth/send-otp { phone: "9876543210" }
    API->>Console: [MiniLedger OTP] Mobile: 9876543210 | Code: 467527
    API-->>User: 200 OK { message: "OTP generated", expiresInSeconds: 300 }
    User->>API: POST /api/auth/verify-otp { phone: "9876543210", otp: "467527" }
    API->>DB: Upsert User (phone)
    DB-->>API: User record (id, phone)
    API-->>User: 200 OK { token: "JWT...", user: { id, phone } }
    User->>User: Store token in AsyncStorage

    Note over User, API: 2. Create Loan & Dashboard Refresh
    User->>API: POST /api/loans (Bearer JWT) { friendName: "Riya", amount: 1500, dueDate: "2026-10-30" }
    API->>DB: INSERT INTO Loan (userId, friendName, amount, dueDate, PENDING)
    DB-->>API: Saved Loan Record
    API-->>User: 201 Created

    User->>API: GET /api/loans/summary (Bearer JWT)
    API->>DB: Aggregate: Total Lent, Total Repaid, Overdue (Pending & dueDate < Today)
    DB-->>API: Aggregated totals
    API-->>User: 200 OK { totalLent: 1500, totalRepaid: 0, overdueAmount: 0, outstandingAmount: 1500 }

    Note over User, API: 3. Repayment Flow
    User->>API: PATCH /api/loans/:id/repay (Bearer JWT)
    API->>DB: Verify ownership (userId == req.userId) & UPDATE status = REPAID
    DB-->>API: Updated Loan
    API-->>User: 200 OK (repaid)
```

---

## 🛠️ Technology Stack

| Layer | Technology | Rationale |
| :--- | :--- | :--- |
| **Mobile Client** | React Native, Expo SDK 53, TypeScript | Cross-platform, instant hot-reloading, zero complex native build config. |
| **API Server** | Node.js, Express, TypeScript | Lightweight, fast asynchronous I/O, clean middleware architecture. |
| **Database** | PostgreSQL (Neon Cloud) | ACID-compliant storage, persistent cloud access, true relational foreign keys. |
| **ORM** | Prisma ORM 6 | Type-safe queries, automatic migration management, declarative schema. |
| **Validation** | Zod | Runtime type safety and precise Indian phone & date validation. |
| **Security** | Helmet, CORS, JWT | Secure headers, token-based stateless authentication, user ownership scoping. |
| **Testing** | Vitest, Supertest | Fast unit and integration tests with 100% assertion reliability. |

---

## 📋 API Specification & Examples

Base URL: `http://localhost:4000`

### 1. Health Check
- **Endpoint**: `GET /api/health`
- **Response**:
```json
{
  "status": "ok",
  "service": "miniledger-api",
  "version": "1.0.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-10-22T21:00:00.000Z"
}
```

### 2. Send Mock OTP
- **Endpoint**: `POST /api/auth/send-otp`
- **Body**: `{ "phone": "9876543210" }`
- **Response**:
```json
{
  "message": "OTP generated. Check the backend terminal in this demo.",
  "expiresInSeconds": 300
}
```
*Note: The 6-digit OTP code is logged directly to the backend terminal for evaluation.*

### 3. Verify OTP & Obtain JWT
- **Endpoint**: `POST /api/auth/verify-otp`
- **Body**: `{ "phone": "9876543210", "otp": "467527" }`
- **Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "cm7...",
    "phone": "9876543210"
  }
}
```

### 4. List User's Loans
- **Endpoint**: `GET /api/loans`
- **Headers**: `Authorization: Bearer <JWT_TOKEN>`
- **Response**: Array of loans sorted by status (`PENDING` first), `dueDate` ascending, then `createdAt` descending.

### 5. Create a New Loan
- **Endpoint**: `POST /api/loans`
- **Headers**: `Authorization: Bearer <JWT_TOKEN>`
- **Body**:
```json
{
  "friendName": "Riya Sharma",
  "amount": 1500,
  "dueDate": "2026-10-30"
}
```
- **Response** `(201 Created)`:
```json
{
  "id": "cm7...",
  "friendName": "Riya Sharma",
  "amount": "1500.00",
  "dueDate": "2026-10-30",
  "status": "PENDING",
  "createdAt": "2026-10-22T21:00:00.000Z",
  "repaidAt": null
}
```

### 6. Mark Loan as Repaid
- **Endpoint**: `PATCH /api/loans/:id/repay`
- **Headers**: `Authorization: Bearer <JWT_TOKEN>`
- **Response**: Returns the updated loan object with `status: "REPAID"` and `repaidAt` timestamp.
- **Security**: Strictly prevents users from repaying loans belonging to other accounts (`404 Loan not found`).

### 7. Financial Summary
- **Endpoint**: `GET /api/loans/summary`
- **Headers**: `Authorization: Bearer <JWT_TOKEN>`
- **Response**:
```json
{
  "totalLent": 4500.00,
  "totalRepaid": 1500.00,
  "overdueAmount": 1200.00,
  "outstandingAmount": 3000.00
}
```

---

## 💰 Core Financial & Overdue Business Rules

1. **Storage Precision**: Amounts are stored using PostgreSQL `Decimal(12, 2)` (NUMERIC), completely avoiding JavaScript binary floating-point representation bugs.
2. **Total Lent**: Sum of all loans created by the authenticated user regardless of status.
3. **Total Repaid**: Sum of all loans where `status = 'REPAID'`.
4. **Outstanding Amount**: `Total Lent - Total Repaid`.
5. **Overdue Amount**: Sum of outstanding (`PENDING`) loans whose `dueDate` is strictly before the current local calendar date (`dueDate < startOfTodayUTC`).
6. **Repaid Immunity**: Loans marked `REPAID` are **never** counted towards overdue amount, even if their due date was in the past.
7. **Strict Ownership Scoping**: Every query, aggregation, and mutation is scoped to `req.userId` extracted from the verified JWT.

---

## 🚀 Setup & Local Development

### Prerequisites
- Node.js 20+
- npm
- Free Neon PostgreSQL connection string from [neon.tech](https://neon.tech)

### 1. Backend Setup
```bash
cd backend
cp .env.example .env
npm install
```

Configure `backend/.env`:
```env
DATABASE_URL="postgresql://user:password@ep-sample.us-east-2.aws.neon.tech/neondb?sslmode=require"
JWT_SECRET="c8e6a210f9b3191d848123fa4d17b8f9e6123491bc13e8b417c802f0689b0918"
PORT=4000
NODE_ENV=development
```

Run database migrations and start server:
```bash
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Run automated Vitest suite:
```bash
npm test
```

### 2. Mobile App Setup
```bash
cd ../mobile
cp .env.example .env
npm install
```

Configure `mobile/.env`:
- For web or local desktop emulator: `EXPO_PUBLIC_API_URL=http://localhost:4000`
- For physical Android/iOS phone running Expo Go: `EXPO_PUBLIC_API_URL=http://<YOUR_LAPTOP_LOCAL_IP>:4000`
- For Android Emulator: `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000`

Start the Expo development server:
```bash
npx expo start
```

---

## 🎥 2:30 Demo Recording Script

| Time | Action | What to Explain / Demonstrate |
| :--- | :--- | :--- |
| **0:00 – 0:20** | Introduction | Introduce MiniLedger: full-stack debt tracking app built with React Native (Expo), Express, TypeScript, and Neon PostgreSQL. |
| **0:20 – 0:45** | Auth & Terminal OTP | Enter 10-digit mobile number, show the generated 6-digit mock OTP in the backend terminal console, enter OTP, and securely log in. |
| **0:45 – 1:15** | Dashboard Overview | Walk through the financial summary card: Total Lent, Outstanding, Repaid, and Overdue totals with live badges and filter tabs. |
| **1:15 – 1:40** | Add Loan | Click `+ Add Loan`, use quick date preset (+7 Days), enter friend's name and amount, submit, and watch dashboard metrics update in real-time. |
| **1:40 – 2:05** | Overdue & Repay | Show an overdue entry highlighted in red (`dueDate < today`). Tap `Mark Repaid`, confirm modal, and observe overdue count decrease while repaid amount increases. |
| **2:05 – 2:30** | Architecture & Code | Briefly show the PostgreSQL Prisma schema (`Decimal(12,2)`), the 15 passing Vitest tests, and user ownership security. |

---

## 🔒 Security & Best Practices

- Real environment credentials (`.env`) are strictly ignored via `.gitignore` and never committed to git.
- Full input validation via Zod schemas for mobile numbers, money amounts, and dates.
- HTTP security headers provided by `helmet` with CORS protection.
- Tamper-proof stateless JWT tokens with 7-day expiration.
- Database cascading deletes on user removal and composite indexes on `(userId, status, dueDate)` for high-performance aggregation queries.
