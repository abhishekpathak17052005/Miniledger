# MiniLedger

A React Native + Express + TypeScript app for tracking money lent to friends.

## Stack
- Mobile: Expo, React Native, TypeScript
- API: Node.js, Express, TypeScript
- Database: PostgreSQL (Neon recommended)
- ORM: Prisma 6
- Authentication: mock OTP + JWT
- Validation: Zod

## Prerequisites
- Node.js 20+
- npm
- A Neon PostgreSQL database
- Expo Go on your phone, or an Android emulator

## 1. Create a cloud database
1. Create a project at https://neon.tech.
2. Open the dashboard and copy the PostgreSQL connection string.
3. Keep it private. Do not paste it into source code or commit it to GitHub.

## 2. Start the backend
```bash
cd backend
cp .env.example .env
```
Edit `backend/.env` and set `DATABASE_URL` to your Neon connection string and set a long random `JWT_SECRET`.

Then run:
```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```
API default: `http://localhost:4000`.

Check health:
```bash
curl http://localhost:4000/api/health
```

### Using a physical phone
Your phone cannot normally reach your laptop using `localhost`. Set `EXPO_PUBLIC_API_URL` in `mobile/.env` to your laptop's LAN IP, e.g. `http://192.168.1.25:4000`, and ensure both devices use the same Wi-Fi and your firewall permits port 4000. For a demo from outside your network, deploy the API to a host such as Render and use its HTTPS URL.

## 3. Start the mobile app
```bash
cd ../mobile
npm install
```
Create `mobile/.env`:
```env
EXPO_PUBLIC_API_URL=http://YOUR_LAPTOP_LAN_IP:4000
```
For Android emulator, `http://10.0.2.2:4000` often reaches the host machine. For web/local testing, use `http://localhost:4000`.
Then:
```bash
npx expo start
```
Scan the QR code with Expo Go or open the Android emulator.

## API overview
- `POST /api/auth/send-otp` `{ "phone": "9876543210" }`
- `POST /api/auth/verify-otp` `{ "phone": "9876543210", "otp": "123456" }`
- `GET /api/loans` (Bearer JWT)
- `POST /api/loans` `{ "friendName": "Riya", "amount": "1200.00", "dueDate": "2026-10-25" }` (Bearer JWT)
- `PATCH /api/loans/:id/repay` (Bearer JWT)
- `GET /api/loans/summary` (Bearer JWT)

The OTP is intentionally printed in the backend terminal for this assignment. It expires after five minutes and has a limited number of attempts. This is a demo authentication flow, not production-grade phone verification.

## Money and overdue rules
- Amounts are stored as PostgreSQL `Decimal` values, not JavaScript floating-point money.
- Total lent includes every loan.
- Total repaid includes loans with `REPAID` status.
- Overdue amount includes pending loans with a due date before the current date.
- A loan is scoped to the authenticated user; the client cannot choose a user ID.

## Before submission
- [ ] Run backend and mobile app from a clean install.
- [ ] Verify OTP login, add loan, overdue display, repayment and summary refresh.
- [ ] Add screenshots to this README.
- [ ] Add tests for validation, auth, and summary calculations.
- [ ] Ensure `.env` files and secrets are not committed.
- [ ] Push the repository to GitHub.
- [ ] Record a 2–3 minute demo showing the server OTP log and app workflow.

## Known MVP limitations
- OTPs are stored in memory; restarting the server invalidates pending OTPs.
- Repayment is all-or-nothing; partial repayments are not supported.
- Receipt uploads are intentionally deferred until core flows work.
