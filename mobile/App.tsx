import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

const API_URL = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
type Loan = { id: string; friendName: string; amount: string; dueDate: string; status: "PENDING" | "REPAID" };
type Summary = { totalLent: number; totalRepaid: number; overdueAmount: number; outstandingAmount: number };

async function api<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}
const rupees = (value: number | string) => `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [summary, setSummary] = useState<Summary>({ totalLent: 0, totalRepaid: 0, overdueAmount: 0, outstandingAmount: 0 });
  const [friendName, setFriendName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void (async () => { const saved = await AsyncStorage.getItem("miniledger_token"); if (saved) setToken(saved); })(); }, []);
  useEffect(() => { if (token) void refresh(); }, [token]);

  async function refresh() {
    if (!token) return;
    try {
      const [items, totals] = await Promise.all([api<Loan[]>("/api/loans", token), api<Summary>("/api/loans/summary", token)]);
      setLoans(items); setSummary(totals); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load loans"); }
  }
  async function sendOtp() {
    setBusy(true); setError("");
    try { await api("/api/auth/send-otp", undefined, { method: "POST", body: JSON.stringify({ phone }) }); setOtpSent(true); Alert.alert("OTP generated", "For this assignment, check the backend terminal for the OTP."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not send OTP"); }
    finally { setBusy(false); }
  }
  async function verifyOtp() {
    setBusy(true); setError("");
    try {
      const result = await api<{ token: string }>("/api/auth/verify-otp", undefined, { method: "POST", body: JSON.stringify({ phone, otp }) });
      await AsyncStorage.setItem("miniledger_token", result.token); setToken(result.token);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not verify OTP"); }
    finally { setBusy(false); }
  }
  async function addLoan() {
    const numericAmount = Number(amount);
    if (!friendName.trim()) return setError("Enter your friend's name.");
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return setError("Enter an amount greater than zero.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) return setError("Enter a due date as YYYY-MM-DD.");
    setBusy(true); setError("");
    try {
      await api("/api/loans", token!, { method: "POST", body: JSON.stringify({ friendName: friendName.trim(), amount: numericAmount, dueDate }) });
      setFriendName(""); setAmount(""); setDueDate(""); setShowForm(false); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add loan"); }
    finally { setBusy(false); }
  }
  async function repay(loan: Loan) {
    try { await api(`/api/loans/${loan.id}/repay`, token!, { method: "PATCH" }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not mark repaid"); }
  }
  async function logout() { await AsyncStorage.removeItem("miniledger_token"); setToken(null); setOtp(""); setOtpSent(false); setLoans([]); }

  if (!token) return (
    <SafeAreaView style={styles.safe}><StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.loginWrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.logo}><Text style={styles.logoText}>M</Text></View>
        <Text style={styles.brand}>MiniLedger</Text><Text style={styles.subtitle}>Keep every promise, track every rupee.</Text>
        <View style={styles.panel}><Text style={styles.heading}>{otpSent ? "Verify your number" : "Welcome back"}</Text>
          <Text style={styles.label}>PHONE NUMBER</Text>
          <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={10} placeholder="10-digit mobile number" />
          {otpSent && <><Text style={styles.label}>ONE-TIME PASSWORD</Text><TextInput style={styles.input} value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} placeholder="6-digit OTP" /></>}
          {!!error && <Text style={styles.error}>{error}</Text>}
          <Pressable style={styles.primary} disabled={busy} onPress={() => void (otpSent ? verifyOtp() : sendOtp())}><Text style={styles.primaryText}>{busy ? "Please wait…" : otpSent ? "Verify & continue" : "Send mock OTP"}</Text></Pressable>
          {otpSent && <Pressable onPress={() => { setOtpSent(false); setOtp(""); }}><Text style={styles.link}>Change phone number</Text></Pressable>}
        </View>
        <Text style={styles.footnote}>Demo login · OTP is printed in the API terminal</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={styles.safe}><StatusBar style="dark" />
      <View style={styles.topbar}><View><Text style={styles.brandSmall}>MiniLedger</Text><Text style={styles.subtitleSmall}>Your lending, in control.</Text></View><Pressable onPress={() => void logout()}><Text style={styles.link}>Log out</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionTitle}>Your overview</Text>
        <View style={styles.hero}><Text style={styles.heroLabel}>TOTAL LENT</Text><Text style={styles.heroAmount}>{rupees(summary.totalLent)}</Text><View style={styles.heroRow}><View><Text style={styles.heroLabel}>REPAID</Text><Text style={styles.heroSmall}>{rupees(summary.totalRepaid)}</Text></View><View><Text style={styles.heroLabel}>OVERDUE</Text><Text style={styles.heroOverdue}>{rupees(summary.overdueAmount)}</Text></View></View></View>
        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Loan entries</Text><Pressable style={styles.addButton} onPress={() => { setShowForm(!showForm); setError(""); }}><Text style={styles.addButtonText}>{showForm ? "Cancel" : "+ Add loan"}</Text></Pressable></View>
        {showForm && <View style={styles.panel}><Text style={styles.heading}>New loan</Text><Text style={styles.label}>FRIEND'S NAME</Text><TextInput style={styles.input} value={friendName} onChangeText={setFriendName} placeholder="e.g. Riya Sharma" maxLength={80} /><Text style={styles.label}>AMOUNT (₹)</Text><TextInput style={styles.input} value={amount} onChangeText={setAmount} placeholder="e.g. 1200" keyboardType="decimal-pad" /><Text style={styles.label}>DUE DATE</Text><TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" /><Pressable style={styles.primary} disabled={busy} onPress={() => void addLoan()}><Text style={styles.primaryText}>{busy ? "Saving…" : "Save loan"}</Text></Pressable></View>}
        {!!error && <Text style={styles.error}>{error}</Text>}
        {loans.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>No loans yet</Text><Text style={styles.subtitle}>Add your first loan to start tracking.</Text></View> :
          <FlatList scrollEnabled={false} data={loans} keyExtractor={(item) => item.id} renderItem={({ item }) => {
            const overdue = item.status === "PENDING" && item.dueDate < today();
            return <View style={[styles.loanCard, overdue && styles.overdueCard]}><View style={styles.loanTop}><View style={styles.avatar}><Text style={styles.avatarText}>{item.friendName.trim().charAt(0).toUpperCase()}</Text></View><View style={styles.loanNameWrap}><Text style={styles.loanName}>{item.friendName}</Text><Text style={styles.loanDue}>Due {item.dueDate}</Text></View><Text style={styles.loanAmount}>{rupees(item.amount)}</Text></View><View style={styles.loanBottom}><Text style={[styles.status, overdue && styles.statusOverdue]}>{item.status === "REPAID" ? "✓ Repaid" : overdue ? "● Overdue" : "● Pending"}</Text>{item.status === "PENDING" && <Pressable onPress={() => void repay(item)}><Text style={styles.link}>Mark repaid</Text></Pressable>}</View></View>;
          }} />}
        <Pressable style={styles.refresh} onPress={() => void refresh()}><Text style={styles.refreshText}>↻ Refresh summary</Text></Pressable>
        <Text style={styles.footnote}>Overdue means an unpaid loan with a due date before today.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F5F7FB" }, loginWrap: { flex: 1, justifyContent: "center", padding: 24 },
  logo: { width: 56, height: 56, borderRadius: 18, backgroundColor: "#2457E6", alignItems: "center", justifyContent: "center", alignSelf: "center", marginBottom: 12 },
  logoText: { color: "white", fontSize: 28, fontWeight: "800" }, brand: { fontSize: 30, fontWeight: "800", color: "#16213E", textAlign: "center" },
  subtitle: { color: "#718096", fontSize: 14, textAlign: "center", marginTop: 7, marginBottom: 28 }, panel: { backgroundColor: "white", borderRadius: 20, padding: 20, marginBottom: 18, borderWidth: 1, borderColor: "#E8ECF4" },
  heading: { fontSize: 20, fontWeight: "800", color: "#18233F", marginBottom: 18 }, label: { fontSize: 11, fontWeight: "800", color: "#778198", letterSpacing: 1, marginBottom: 8, marginTop: 10 },
  input: { borderWidth: 1, borderColor: "#E0E6F0", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, color: "#18233F", backgroundColor: "#FBFCFE", marginBottom: 8 },
  primary: { backgroundColor: "#2457E6", borderRadius: 12, alignItems: "center", paddingVertical: 15, marginTop: 12 }, primaryText: { color: "white", fontWeight: "800", fontSize: 15 },
  link: { color: "#2457E6", fontWeight: "700", fontSize: 13 }, footnote: { color: "#98A2B3", fontSize: 11, textAlign: "center", marginTop: 14 },
  error: { color: "#C53030", fontSize: 13, marginVertical: 8 }, topbar: { paddingHorizontal: 22, paddingTop: 14, paddingBottom: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brandSmall: { fontSize: 23, fontWeight: "900", color: "#16213E" }, subtitleSmall: { color: "#718096", fontSize: 12, marginTop: 2 },
  content: { paddingHorizontal: 18, paddingBottom: 28 }, sectionTitle: { fontSize: 18, fontWeight: "800", color: "#18233F", marginBottom: 12 },
  hero: { backgroundColor: "#1F4FD6", borderRadius: 22, padding: 20, marginBottom: 24 }, heroLabel: { color: "#C9D8FF", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  heroAmount: { color: "white", fontSize: 32, fontWeight: "900", marginTop: 7, marginBottom: 22 }, heroRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#5276E2", paddingTop: 14 },
  heroSmall: { color: "white", fontSize: 16, fontWeight: "800", marginTop: 5 }, heroOverdue: { color: "#FFD5D5", fontSize: 16, fontWeight: "800", marginTop: 5 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }, addButton: { backgroundColor: "#E6ECFF", paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10 }, addButtonText: { color: "#2457E6", fontWeight: "800", fontSize: 13 },
  loanCard: { backgroundColor: "white", borderRadius: 16, padding: 15, marginBottom: 10, borderWidth: 1, borderColor: "#E6EAF2" }, overdueCard: { borderColor: "#F3A6A6", backgroundColor: "#FFF9F9" },
  loanTop: { flexDirection: "row", alignItems: "center" }, avatar: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#E9EEFF", alignItems: "center", justifyContent: "center" }, avatarText: { color: "#2457E6", fontSize: 17, fontWeight: "900" },
  loanNameWrap: { flex: 1, marginLeft: 11 }, loanName: { fontSize: 15, color: "#18233F", fontWeight: "800" }, loanDue: { fontSize: 11, color: "#8590A4", marginTop: 4 }, loanAmount: { color: "#18233F", fontWeight: "900", fontSize: 14 },
  loanBottom: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#EEF0F5", marginTop: 13, paddingTop: 11 }, status: { color: "#A06B12", fontSize: 12, fontWeight: "800" }, statusOverdue: { color: "#C53030" },
  empty: { padding: 30, alignItems: "center", backgroundColor: "white", borderRadius: 16 }, emptyTitle: { color: "#18233F", fontSize: 16, fontWeight: "800", marginBottom: 4 },
  refresh: { padding: 14, alignItems: "center" }, refreshText: { color: "#2457E6", fontWeight: "700" },
});
