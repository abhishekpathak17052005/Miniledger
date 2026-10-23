import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

const getDefaultApiUrl = (): string => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, "");
  }
  // Android emulator connects to host machine via 10.0.2.2
  if (Platform.OS === "android") {
    return "http://10.0.2.2:4000";
  }
  // Web & iOS Simulator connect to localhost
  return "http://localhost:4000";
};

const API_URL = getDefaultApiUrl();

type Loan = {
  id: string;
  friendName: string;
  amount: string;
  dueDate: string;
  status: "PENDING" | "REPAID";
  createdAt?: string;
  repaidAt?: string | null;
};

type Summary = {
  totalLent: number;
  totalRepaid: number;
  overdueAmount: number;
  outstandingAmount: number;
};

type FilterType = "ALL" | "PENDING" | "OVERDUE" | "REPAID";

interface ApiError extends Error {
  status?: number;
  retryAfterSeconds?: number;
}

async function api<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
  } catch {
    const err: ApiError = new Error(
      `Cannot connect to MiniLedger backend at ${API_URL}. Ensure the server is running.`
    );
    throw err;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      body.error ||
      (response.status === 429
        ? "Too many requests. Please wait a moment before trying again."
        : `Request failed with status ${response.status}`);
    const err: ApiError = new Error(message);
    err.status = response.status;
    err.retryAfterSeconds = body.retryAfterSeconds;
    throw err;
  }
  return body as T;
}

const rupees = (value: number | string) =>
  `₹${Number(value || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const getTodayDateString = () => new Date().toISOString().slice(0, 10);

const addDaysToDate = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const normalizePhone = (raw: string): string =>
  raw.trim().replace(/[\s-]/g, "").replace(/^(\+91|0)/, "");

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [userPhone, setUserPhone] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const [loans, setLoans] = useState<Loan[]>([]);
  const [summary, setSummary] = useState<Summary>({
    totalLent: 0,
    totalRepaid: 0,
    overdueAmount: 0,
    outstandingAmount: 0,
  });

  // Form states
  const [friendName, setFriendName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(addDaysToDate(7));
  const [showForm, setShowForm] = useState(false);

  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterType>("ALL");

  // Interaction states
  const [busy, setBusy] = useState(false);
  const [repayingId, setRepayingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cooldown countdown tick
  useEffect(() => {
    if (cooldown > 0) {
      cooldownTimerRef.current = setInterval(() => {
        setCooldown((prev) => {
          if (prev <= 1) {
            if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, [cooldown]);

  // Auto-dismiss success messages after 4 seconds
  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(""), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  useEffect(() => {
    void (async () => {
      try {
        const savedToken = await AsyncStorage.getItem("miniledger_token");
        const savedPhone = await AsyncStorage.getItem("miniledger_phone");
        if (savedToken) {
          setToken(savedToken);
          if (savedPhone) setUserPhone(savedPhone);
        }
      } catch {
        // ignore storage read issues
      }
    })();
  }, []);

  useEffect(() => {
    if (token) void refresh();
  }, [token]);

  async function refresh() {
    if (!token) return;
    try {
      setRefreshing(true);
      const [items, totals] = await Promise.all([
        api<Loan[]>("/api/loans", token),
        api<Summary>("/api/loans/summary", token),
      ]);
      setLoans(items);
      setSummary(totals);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load loans");
    } finally {
      setRefreshing(false);
    }
  }

  async function requestOtpCode() {
    const normalized = normalizePhone(phone);
    if (!/^[6-9]\d{9}$/.test(normalized)) {
      setError("Please enter a valid 10-digit Indian mobile number (e.g. 9876543210)");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await api<{ message: string; expiresInSeconds?: number }>(
        "/api/auth/request-otp",
        undefined,
        {
          method: "POST",
          body: JSON.stringify({ phone: normalized }),
        }
      );
      setOtpSent(true);
      setCooldown(60);
      setSuccessMessage("OTP generated! Check your backend terminal console.");
      Alert.alert(
        "Mock OTP Generated",
        res.message || "Check the backend terminal console to view your 6-digit OTP code."
      );
    } catch (e: any) {
      const retrySec = e?.retryAfterSeconds;
      if (retrySec && typeof retrySec === "number") {
        setCooldown(retrySec);
      }
      setError(e instanceof Error ? e.message : "Could not request OTP");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtpCode() {
    const normalized = normalizePhone(phone);
    const cleanOtp = otp.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      setError("Please enter the 6-digit OTP code");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: string; user: { id: string; phone: string } }>(
        "/api/auth/verify-otp",
        undefined,
        {
          method: "POST",
          body: JSON.stringify({ phone: normalized, otp: cleanOtp }),
        }
      );
      await AsyncStorage.setItem("miniledger_token", result.token);
      await AsyncStorage.setItem("miniledger_phone", result.user.phone);
      setUserPhone(result.user.phone);
      setToken(result.token);
      setSuccessMessage("Logged in successfully!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify OTP");
    } finally {
      setBusy(false);
    }
  }

  async function addLoan() {
    const trimmedName = friendName.trim();
    const numericAmount = Number(amount);

    if (!trimmedName) {
      setError("Please enter your friend's name.");
      return;
    }
    if (trimmedName.length > 80) {
      setError("Friend name cannot exceed 80 characters.");
      return;
    }
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Please enter a positive loan amount greater than ₹0.");
      return;
    }
    const decimalParts = amount.includes(".") ? amount.split(".")[1] : "";
    if (decimalParts.length > 2) {
      setError("Amount cannot have more than 2 decimal places.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) {
      setError("Enter a valid due date in YYYY-MM-DD format.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await api("/api/loans", token!, {
        method: "POST",
        body: JSON.stringify({
          friendName: trimmedName,
          amount: numericAmount,
          dueDate,
        }),
      });
      setFriendName("");
      setAmount("");
      setDueDate(addDaysToDate(7));
      setShowForm(false);
      setSuccessMessage(`Loan of ${rupees(numericAmount)} to ${trimmedName} recorded!`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add loan");
    } finally {
      setBusy(false);
    }
  }

  function confirmRepayment(loan: Loan) {
    if (busy || repayingId) return;
    Alert.alert(
      "Confirm Repayment",
      `Mark loan of ${rupees(loan.amount)} to ${loan.friendName} as fully repaid?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm Repay",
          style: "default",
          onPress: () => void executeRepay(loan),
        },
      ]
    );
  }

  async function executeRepay(loan: Loan) {
    if (repayingId) return;
    setRepayingId(loan.id);
    setError("");
    try {
      await api(`/api/loans/${loan.id}/repay`, token!, { method: "PATCH" });
      setSuccessMessage(`Loan to ${loan.friendName} marked as repaid!`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark loan as repaid");
    } finally {
      setRepayingId(null);
    }
  }

  async function logout() {
    Alert.alert("Log Out", "Are you sure you want to log out of MiniLedger?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: async () => {
          await AsyncStorage.multiRemove(["miniledger_token", "miniledger_phone"]);
          setToken(null);
          setUserPhone("");
          setPhone("");
          setOtp("");
          setOtpSent(false);
          setCooldown(0);
          setLoans([]);
          setError("");
          setSuccessMessage("");
        },
      },
    ]);
  }

  const todayStr = getTodayDateString();

  // Filter and search logic
  const filteredLoans = useMemo(() => {
    return loans.filter((loan) => {
      const isOverdue = loan.status === "PENDING" && loan.dueDate < todayStr;

      // Filter category
      if (activeFilter === "PENDING" && (loan.status !== "PENDING" || isOverdue)) return false;
      if (activeFilter === "OVERDUE" && !isOverdue) return false;
      if (activeFilter === "REPAID" && loan.status !== "REPAID") return false;

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        return (
          loan.friendName.toLowerCase().includes(query) ||
          loan.amount.includes(query) ||
          loan.dueDate.includes(query)
        );
      }
      return true;
    });
  }, [loans, activeFilter, searchQuery, todayStr]);

  // Counts for filter pills
  const counts = useMemo(() => {
    let pending = 0;
    let overdue = 0;
    let repaid = 0;
    for (const l of loans) {
      if (l.status === "REPAID") repaid++;
      else if (l.dueDate < todayStr) overdue++;
      else pending++;
    }
    return { all: loans.length, pending, overdue, repaid };
  }, [loans, todayStr]);

  // Login View
  if (!token) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          style={styles.loginWrap}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.logo}>
            <Text style={styles.logoText}>₹</Text>
          </View>
          <Text style={styles.brand}>MiniLedger</Text>
          <Text style={styles.subtitle}>Track loans to friends with clarity & peace of mind.</Text>

          <View style={styles.panel}>
            <Text style={styles.heading}>{otpSent ? "Verify Mobile OTP" : "Welcome to MiniLedger"}</Text>
            <Text style={styles.helperText}>
              {otpSent
                ? `Enter the 6-digit code printed in the backend terminal for ${phone}`
                : "Enter your 10-digit Indian mobile number to log in or create an account."}
            </Text>

            <Text style={styles.label}>MOBILE NUMBER</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={(t) => {
                setPhone(t);
                if (error) setError("");
              }}
              keyboardType="phone-pad"
              maxLength={13}
              placeholder="e.g. 9876543210"
              placeholderTextColor="#A0AEC0"
              editable={!otpSent && !busy}
            />

            {otpSent && (
              <>
                <Text style={styles.label}>ONE-TIME PASSWORD (OTP)</Text>
                <TextInput
                  style={[styles.input, styles.otpInput]}
                  value={otp}
                  onChangeText={(t) => {
                    setOtp(t);
                    if (error) setError("");
                  }}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="6-digit OTP"
                  placeholderTextColor="#A0AEC0"
                  editable={!busy}
                />
              </>
            )}

            {!!error && <Text style={styles.error}>{error}</Text>}
            {!!successMessage && <Text style={styles.successBanner}>{successMessage}</Text>}

            <Pressable
              style={[styles.primary, busy && styles.buttonDisabled]}
              disabled={busy}
              onPress={() => void (otpSent ? verifyOtpCode() : requestOtpCode())}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={styles.primaryText}>
                  {otpSent ? "Verify & Log In" : "Send Mock OTP"}
                </Text>
              )}
            </Pressable>

            {otpSent && (
              <View style={styles.otpActionsRow}>
                <Pressable
                  style={[styles.resendButton, (busy || cooldown > 0) && styles.buttonDisabled]}
                  disabled={busy || cooldown > 0}
                  onPress={() => void requestOtpCode()}
                >
                  <Text style={[styles.link, cooldown > 0 && styles.linkMuted]}>
                    {cooldown > 0 ? `Resend OTP in ${cooldown}s` : "↻ Resend OTP"}
                  </Text>
                </Pressable>

                <Pressable
                  style={styles.changePhoneButton}
                  onPress={() => {
                    setOtpSent(false);
                    setOtp("");
                    setError("");
                    setSuccessMessage("");
                  }}
                >
                  <Text style={styles.link}>← Change number</Text>
                </Pressable>
              </View>
            )}
          </View>

          <View style={styles.demoNoteCard}>
            <Text style={styles.demoNoteTitle}>Demo Verification Notice</Text>
            <Text style={styles.demoNoteBody}>
              For this technical assignment, OTPs are printed directly in the backend terminal console. Never hardcode an OTP in the application.
            </Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Authenticated Dashboard View
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.topbar}>
        <View>
          <Text style={styles.brandSmall}>MiniLedger</Text>
          <Text style={styles.subtitleSmall}>
            {userPhone ? `Logged in as +91 ${userPhone}` : "Personal Lending Dashboard"}
          </Text>
        </View>
        <Pressable style={styles.logoutButton} onPress={() => void logout()}>
          <Text style={styles.logoutText}>Log Out</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor="#2457E6" />
        }
      >
        {/* Financial Summary Card */}
        <View style={styles.hero}>
          <View style={styles.heroHeaderRow}>
            <Text style={styles.heroLabel}>TOTAL LENT</Text>
            <View style={styles.liveIndicator}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>Live</Text>
            </View>
          </View>
          <Text style={styles.heroAmount}>{rupees(summary.totalLent)}</Text>

          <View style={styles.heroStatsGrid}>
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>OUTSTANDING</Text>
              <Text style={styles.statValueOutstanding}>{rupees(summary.outstandingAmount)}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>REPAID</Text>
              <Text style={styles.statValueRepaid}>{rupees(summary.totalRepaid)}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statBox}>
              <Text style={styles.statLabel}>OVERDUE</Text>
              <Text style={styles.statValueOverdue}>{rupees(summary.overdueAmount)}</Text>
            </View>
          </View>
        </View>

        {/* Section Header with Add Loan Button */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Loan Records ({loans.length})</Text>
          <Pressable
            style={[styles.addButton, showForm && styles.addButtonCancel]}
            onPress={() => {
              setShowForm(!showForm);
              setError("");
            }}
          >
            <Text style={[styles.addButtonText, showForm && styles.addButtonTextCancel]}>
              {showForm ? "✕ Cancel" : "+ Add Loan"}
            </Text>
          </Pressable>
        </View>

        {/* Add Loan Form */}
        {showForm && (
          <View style={styles.panel}>
            <Text style={styles.heading}>Record New Loan</Text>

            <Text style={styles.label}>FRIEND'S NAME</Text>
            <TextInput
              style={styles.input}
              value={friendName}
              onChangeText={(t) => {
                setFriendName(t);
                if (error) setError("");
              }}
              placeholder="e.g. Riya Sharma"
              placeholderTextColor="#A0AEC0"
              maxLength={80}
            />

            <Text style={styles.label}>AMOUNT (₹)</Text>
            <TextInput
              style={styles.input}
              value={amount}
              onChangeText={(t) => {
                setAmount(t);
                if (error) setError("");
              }}
              placeholder="e.g. 1500"
              placeholderTextColor="#A0AEC0"
              keyboardType="decimal-pad"
            />

            <Text style={styles.label}>DUE DATE (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              value={dueDate}
              onChangeText={(t) => {
                setDueDate(t);
                if (error) setError("");
              }}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#A0AEC0"
            />

            {/* Quick Date Presets */}
            <View style={styles.presetsRow}>
              <Text style={styles.presetsLabel}>Presets:</Text>
              <Pressable style={styles.presetChip} onPress={() => setDueDate(addDaysToDate(0))}>
                <Text style={styles.presetText}>Today</Text>
              </Pressable>
              <Pressable style={styles.presetChip} onPress={() => setDueDate(addDaysToDate(7))}>
                <Text style={styles.presetText}>+7 Days</Text>
              </Pressable>
              <Pressable style={styles.presetChip} onPress={() => setDueDate(addDaysToDate(15))}>
                <Text style={styles.presetText}>+15 Days</Text>
              </Pressable>
              <Pressable style={styles.presetChip} onPress={() => setDueDate(addDaysToDate(30))}>
                <Text style={styles.presetText}>+30 Days</Text>
              </Pressable>
            </View>

            {!!error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.primary, busy && styles.buttonDisabled]}
              disabled={busy}
              onPress={() => void addLoan()}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={styles.primaryText}>Save Loan</Text>
              )}
            </Pressable>
          </View>
        )}

        {/* Global Feedback Banners */}
        {!!error && <Text style={styles.errorBanner}>{error}</Text>}
        {!!successMessage && <Text style={styles.successBanner}>{successMessage}</Text>}

        {/* Search & Filter Bar */}
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="🔍 Search friend, amount or date..."
            placeholderTextColor="#8898AA"
          />
        </View>

        {/* Filter Chips */}
        <View style={styles.filterRow}>
          <Pressable
            style={[styles.filterChip, activeFilter === "ALL" && styles.filterChipActive]}
            onPress={() => setActiveFilter("ALL")}
          >
            <Text style={[styles.filterChipText, activeFilter === "ALL" && styles.filterChipTextActive]}>
              All ({counts.all})
            </Text>
          </Pressable>

          <Pressable
            style={[styles.filterChip, activeFilter === "PENDING" && styles.filterChipActive]}
            onPress={() => setActiveFilter("PENDING")}
          >
            <Text style={[styles.filterChipText, activeFilter === "PENDING" && styles.filterChipTextActive]}>
              Pending ({counts.pending})
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.filterChip,
              activeFilter === "OVERDUE" && styles.filterChipActiveOverdue,
            ]}
            onPress={() => setActiveFilter("OVERDUE")}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFilter === "OVERDUE" && styles.filterChipTextActiveOverdue,
              ]}
            >
              Overdue ({counts.overdue})
            </Text>
          </Pressable>

          <Pressable
            style={[styles.filterChip, activeFilter === "REPAID" && styles.filterChipActiveRepaid]}
            onPress={() => setActiveFilter("REPAID")}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFilter === "REPAID" && styles.filterChipTextActiveRepaid,
              ]}
            >
              Repaid ({counts.repaid})
            </Text>
          </Pressable>
        </View>

        {/* Loans List or Empty State */}
        {filteredLoans.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyTitle}>
              {loans.length === 0 ? "No loans recorded yet" : "No matching loans found"}
            </Text>
            <Text style={styles.emptySubtitle}>
              {loans.length === 0
                ? "Tap '+ Add Loan' above to record your first entry."
                : "Try clearing your search query or filter selection."}
            </Text>
          </View>
        ) : (
          <FlatList
            scrollEnabled={false}
            data={filteredLoans}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const isOverdue = item.status === "PENDING" && item.dueDate < todayStr;
              const isItemRepaying = repayingId === item.id;
              return (
                <View
                  style={[
                    styles.loanCard,
                    isOverdue && styles.overdueCard,
                    item.status === "REPAID" && styles.repaidCard,
                  ]}
                >
                  <View style={styles.loanTop}>
                    <View
                      style={[
                        styles.avatar,
                        isOverdue && styles.avatarOverdue,
                        item.status === "REPAID" && styles.avatarRepaid,
                      ]}
                    >
                      <Text
                        style={[
                          styles.avatarText,
                          isOverdue && styles.avatarTextOverdue,
                          item.status === "REPAID" && styles.avatarTextRepaid,
                        ]}
                      >
                        {item.friendName.trim().charAt(0).toUpperCase()}
                      </Text>
                    </View>

                    <View style={styles.loanNameWrap}>
                      <Text style={styles.loanName}>{item.friendName}</Text>
                      <Text style={styles.loanDue}>
                        {isOverdue ? `⚠️ Overdue since ${item.dueDate}` : `Due: ${item.dueDate}`}
                      </Text>
                    </View>

                    <Text
                      style={[
                        styles.loanAmount,
                        isOverdue && styles.loanAmountOverdue,
                        item.status === "REPAID" && styles.loanAmountRepaid,
                      ]}
                    >
                      {rupees(item.amount)}
                    </Text>
                  </View>

                  <View style={styles.loanBottom}>
                    <View
                      style={[
                        styles.statusBadge,
                        isOverdue && styles.badgeOverdue,
                        item.status === "REPAID" && styles.badgeRepaid,
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusText,
                          isOverdue && styles.statusTextOverdue,
                          item.status === "REPAID" && styles.statusTextRepaid,
                        ]}
                      >
                        {item.status === "REPAID"
                          ? "✓ Repaid"
                          : isOverdue
                          ? "● Overdue"
                          : "● Pending"}
                      </Text>
                    </View>

                    {item.status === "PENDING" && (
                      <Pressable
                        style={[
                          styles.repayButton,
                          (busy || repayingId !== null) && styles.buttonDisabled,
                        ]}
                        disabled={busy || repayingId !== null}
                        onPress={() => confirmRepayment(item)}
                      >
                        {isItemRepaying ? (
                          <ActivityIndicator size="small" color="#175CD3" />
                        ) : (
                          <Text style={styles.repayButtonText}>Mark Repaid</Text>
                        )}
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            }}
          />
        )}

        <Pressable style={styles.refresh} onPress={() => void refresh()}>
          <Text style={styles.refreshText}>↻ Tap to refresh summary</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7F9FC" },
  loginWrap: { flex: 1, justifyContent: "center", padding: 22 },
  logo: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: "#1F4FD6",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 14,
    shadowColor: "#1F4FD6",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  logoText: { color: "white", fontSize: 32, fontWeight: "900" },
  brand: { fontSize: 32, fontWeight: "900", color: "#101828", textAlign: "center" },
  subtitle: {
    color: "#667085",
    fontSize: 14,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  panel: {
    backgroundColor: "white",
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#E4E7EC",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  heading: { fontSize: 20, fontWeight: "800", color: "#101828", marginBottom: 6 },
  helperText: { fontSize: 13, color: "#667085", marginBottom: 16 },
  label: {
    fontSize: 11,
    fontWeight: "800",
    color: "#475467",
    letterSpacing: 0.8,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#D0D5DD",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#101828",
    backgroundColor: "#F9FAFB",
    marginBottom: 6,
  },
  otpInput: {
    letterSpacing: 6,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  primary: {
    backgroundColor: "#1F4FD6",
    borderRadius: 12,
    alignItems: "center",
    paddingVertical: 14,
    marginTop: 14,
  },
  buttonDisabled: { opacity: 0.55 },
  primaryText: { color: "white", fontWeight: "800", fontSize: 15 },
  link: { color: "#1F4FD6", fontWeight: "700", fontSize: 13, textAlign: "center" },
  linkMuted: { color: "#98A2B3" },
  otpActionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 14,
    paddingHorizontal: 4,
  },
  resendButton: { paddingVertical: 4 },
  changePhoneButton: { paddingVertical: 4 },
  error: { color: "#D92D20", fontSize: 13, marginVertical: 6, fontWeight: "600" },
  errorBanner: {
    backgroundColor: "#FEE4E2",
    color: "#B42318",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    fontWeight: "600",
    fontSize: 13,
  },
  successBanner: {
    backgroundColor: "#D1FADF",
    color: "#027A48",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
    fontWeight: "600",
    fontSize: 13,
  },
  demoNoteCard: {
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#B2DDFF",
    borderRadius: 14,
    padding: 14,
    marginTop: 8,
  },
  demoNoteTitle: { color: "#175CD3", fontWeight: "800", fontSize: 12, marginBottom: 4 },
  demoNoteBody: { color: "#1849A9", fontSize: 12 },
  topbar: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandSmall: { fontSize: 24, fontWeight: "900", color: "#101828" },
  subtitleSmall: { color: "#667085", fontSize: 12, marginTop: 2 },
  logoutButton: {
    backgroundColor: "#F2F4F7",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  logoutText: { color: "#344054", fontWeight: "700", fontSize: 12 },
  content: { paddingHorizontal: 18, paddingBottom: 32 },
  sectionTitle: { fontSize: 18, fontWeight: "800", color: "#101828" },
  hero: {
    backgroundColor: "#163AB0",
    borderRadius: 22,
    padding: 20,
    marginBottom: 20,
    shadowColor: "#163AB0",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  heroHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroLabel: { color: "#C8D5FB", fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  liveIndicator: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#48D18C", marginRight: 5 },
  liveText: { color: "white", fontSize: 11, fontWeight: "700" },
  heroAmount: {
    color: "white",
    fontSize: 34,
    fontWeight: "900",
    marginTop: 6,
    marginBottom: 18,
  },
  heroStatsGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.15)",
    paddingTop: 14,
  },
  statBox: { flex: 1, alignItems: "center" },
  statDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.15)", marginHorizontal: 4 },
  statLabel: { color: "#B8CBF8", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  statValueOutstanding: { color: "white", fontSize: 15, fontWeight: "900", marginTop: 4 },
  statValueRepaid: { color: "#7CE8B8", fontSize: 15, fontWeight: "900", marginTop: 4 },
  statValueOverdue: { color: "#FF9C9C", fontSize: 15, fontWeight: "900", marginTop: 4 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  addButton: {
    backgroundColor: "#1F4FD6",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  addButtonCancel: { backgroundColor: "#F2F4F7" },
  addButtonText: { color: "white", fontWeight: "800", fontSize: 13 },
  addButtonTextCancel: { color: "#344054" },
  presetsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: 6,
    marginBottom: 8,
  },
  presetsLabel: { fontSize: 11, color: "#667085", marginRight: 6, fontWeight: "600" },
  presetChip: {
    backgroundColor: "#EAECF0",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 6,
    marginVertical: 2,
  },
  presetText: { fontSize: 11, color: "#344054", fontWeight: "700" },
  searchWrap: { marginBottom: 12 },
  searchInput: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#E4E7EC",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: "#101828",
  },
  filterRow: { flexDirection: "row", marginBottom: 14 },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#F2F4F7",
    marginRight: 8,
  },
  filterChipActive: { backgroundColor: "#1F4FD6" },
  filterChipActiveOverdue: { backgroundColor: "#D92D20" },
  filterChipActiveRepaid: { backgroundColor: "#079455" },
  filterChipText: { fontSize: 12, fontWeight: "700", color: "#475467" },
  filterChipTextActive: { color: "white" },
  filterChipTextActiveOverdue: { color: "white" },
  filterChipTextActiveRepaid: { color: "white" },
  loanCard: {
    backgroundColor: "white",
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#E4E7EC",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  overdueCard: {
    borderColor: "#FDA29B",
    backgroundColor: "#FFFBFA",
  },
  repaidCard: {
    borderColor: "#ABEFC6",
    backgroundColor: "#F6FEF9",
  },
  loanTop: { flexDirection: "row", alignItems: "center" },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "#EFF8FF",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarOverdue: { backgroundColor: "#FEE4E2" },
  avatarRepaid: { backgroundColor: "#D1FADF" },
  avatarText: { color: "#1F4FD6", fontSize: 18, fontWeight: "900" },
  avatarTextOverdue: { color: "#D92D20" },
  avatarTextRepaid: { color: "#079455" },
  loanNameWrap: { flex: 1, marginLeft: 12 },
  loanName: { fontSize: 16, color: "#101828", fontWeight: "800" },
  loanDue: { fontSize: 12, color: "#667085", marginTop: 3 },
  loanAmount: { color: "#101828", fontWeight: "900", fontSize: 16 },
  loanAmountOverdue: { color: "#D92D20" },
  loanAmountRepaid: { color: "#079455" },
  loanBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#F2F4F7",
    marginTop: 12,
    paddingTop: 10,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "#F8F9FC",
  },
  badgeOverdue: { backgroundColor: "#FEE4E2" },
  badgeRepaid: { backgroundColor: "#D1FADF" },
  statusText: { color: "#B54708", fontSize: 11, fontWeight: "800" },
  statusTextOverdue: { color: "#D92D20" },
  statusTextRepaid: { color: "#079455" },
  repayButton: {
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#B2DDFF",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    minWidth: 84,
    alignItems: "center",
  },
  repayButtonText: { color: "#175CD3", fontWeight: "800", fontSize: 12 },
  empty: {
    padding: 36,
    alignItems: "center",
    backgroundColor: "white",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E4E7EC",
  },
  emptyIcon: { fontSize: 32, marginBottom: 8 },
  emptyTitle: { color: "#101828", fontSize: 16, fontWeight: "800", marginBottom: 4 },
  emptySubtitle: { color: "#667085", fontSize: 13, textAlign: "center" },
  refresh: { padding: 14, alignItems: "center" },
  refreshText: { color: "#1F4FD6", fontWeight: "700", fontSize: 13 },
});
