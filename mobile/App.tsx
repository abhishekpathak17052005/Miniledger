import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";

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

type Repayment = {
  id: string;
  loanId: string;
  amount: string;
  repaidAt: string;
  note?: string | null;
};

type Loan = {
  id: string;
  friendId?: string | null;
  friendName: string;
  amount: string;
  dueDate: string;
  status: "PENDING" | "REPAID";
  customOverdueAmount?: string | null;
  hasReceipt?: boolean;
  receiptUrl?: string | null;
  createdAt?: string;
  repaidAt?: string | null;
  repaidAmount?: number;
  remainingAmount?: number;
  repayments?: Repayment[];
};

type Friend = {
  id: string;
  name: string;
  phone?: string | null;
  totalLent: number;
  totalRepaid: number;
  outstandingAmount: number;
  overdueAmount: number;
  loansCount: number;
  activeLoansCount?: number;
  latestActivityDate?: string;
  createdAt?: string;
  updatedAt?: string;
};

type FriendProfile = Friend & {
  loans: Loan[];
};

type Summary = {
  totalLent: number;
  totalRepaid: number;
  overdueAmount: number;
  outstandingAmount: number;
};

type FriendFilterType = "ALL" | "OUTSTANDING" | "OVERDUE" | "SETTLED";

type SelectedReceipt = {
  uri: string;
  base64: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  fileSize?: number;
  fileName?: string;
};

interface ApiError extends Error {
  status?: number;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
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
    err.details = body;
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

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const formatActivityDate = (dateStr?: string | null): string => {
  if (!dateStr) return "Recently";
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "Recently";
    return d.toLocaleDateString("en-IN", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "Recently";
  }
};

function AppContent() {
  const insets = useSafeAreaInsets();
  const [token, setToken] = useState<string | null>(null);
  const [userPhone, setUserPhone] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const [friends, setFriends] = useState<Friend[]>([]);
  const [summary, setSummary] = useState<Summary>({
    totalLent: 0,
    totalRepaid: 0,
    overdueAmount: 0,
    outstandingAmount: 0,
  });

  // Friend detail view state
  const [viewingFriend, setViewingFriend] = useState<FriendProfile | null>(null);
  const [loadingFriend, setLoadingFriend] = useState(false);

  // Form states
  const [friendName, setFriendName] = useState("");
  const [friendPhone, setFriendPhone] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [friendSearch, setFriendSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(addDaysToDate(7));
  const [customOverdueInput, setCustomOverdueInput] = useState("");
  const [selectedReceipt, setSelectedReceipt] = useState<SelectedReceipt | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Duplicate conflict state
  const [duplicateMatches, setDuplicateMatches] = useState<Friend[] | null>(null);

  // Repayment form modal inside friend detail
  const [repayingLoan, setRepayingLoan] = useState<Loan | null>(null);
  const [repaymentAmountInput, setRepaymentAmountInput] = useState("");
  const [repaymentNoteInput, setRepaymentNoteInput] = useState("");

  // Overdue amount modal states
  const [editingOverdueLoan, setEditingOverdueLoan] = useState<Loan | null>(null);
  const [overdueAmountInput, setOverdueAmountInput] = useState("");
  const [overdueModalError, setOverdueModalError] = useState("");

  // Receipt viewer modal states
  const [viewingReceiptLoan, setViewingReceiptLoan] = useState<Loan | null>(null);
  const [viewingReceiptUrl, setViewingReceiptUrl] = useState<string | null>(null);
  const [loadingReceiptImage, setLoadingReceiptImage] = useState(false);

  // Filter & Search states (Friend level)
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFriendFilter, setActiveFriendFilter] = useState<FriendFilterType>("ALL");

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
      const [totals, friendItems] = await Promise.all([
        api<Summary>("/api/loans/summary", token),
        api<Friend[]>("/api/friends", token),
      ]);
      setSummary(totals);
      setFriends(friendItems);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load data");
    } finally {
      setRefreshing(false);
    }
  }

  async function openFriendProfile(friendId: string) {
    setLoadingFriend(true);
    try {
      const profile = await api<FriendProfile>(`/api/friends/${friendId}`, token!);
      setViewingFriend(profile);
      setRepayingLoan(null);
      setRepaymentAmountInput("");
      setRepaymentNoteInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load friend profile");
    } finally {
      setLoadingFriend(false);
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
      if (e.status === 429 && e.retryAfterSeconds) {
        setCooldown(e.retryAfterSeconds);
        setOtpSent(true);
        setError(`Please wait ${e.retryAfterSeconds}s before requesting a new OTP.`);
      } else {
        setError(e?.message || "Failed to request OTP. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtpCode() {
    const trimmedOtp = otp.trim();
    if (!/^\d{6}$/.test(trimmedOtp)) {
      setError("Please enter a valid 6-digit OTP code.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: { id: string; phone: string } }>(
        "/api/auth/verify-otp",
        undefined,
        {
          method: "POST",
          body: JSON.stringify({ phone: normalizePhone(phone), otp: trimmedOtp }),
        }
      );
      await AsyncStorage.setItem("miniledger_token", res.token);
      await AsyncStorage.setItem("miniledger_phone", res.user.phone);
      setToken(res.token);
      setUserPhone(res.user.phone);
      setOtp("");
      setOtpSent(false);
      setCooldown(0);
      setSuccessMessage("Login successful! Welcome to MiniLedger.");
    } catch (e: any) {
      setError(e?.message || "Failed to verify OTP. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function chooseReceiptPhoto() {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission Required",
          "MiniLedger needs access to your photo library to attach receipt photos."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.8,
        base64: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert("Attachment Error", "Could not read image content. Please choose another image.");
        return;
      }

      let contentType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg";
      const uriLower = (asset.uri || "").toLowerCase();
      if (uriLower.endsWith(".png")) contentType = "image/png";
      else if (uriLower.endsWith(".webp")) contentType = "image/webp";

      setSelectedReceipt({
        uri: asset.uri,
        base64: asset.base64,
        contentType,
        fileSize: asset.fileSize,
        fileName: asset.fileName || "receipt.jpg",
      });
    } catch (err: any) {
      Alert.alert("Attachment Error", err?.message || "Could not select photo.");
    }
  }

  function removeSelectedReceipt() {
    setSelectedReceipt(null);
  }

  async function handleAddLoan() {
    let targetFriendId = selectedFriend?.id;
    let targetFriendName = selectedFriend?.name;

    if (!targetFriendId) {
      const trimmedName = friendName.trim().replace(/\s+/g, " ");
      if (!trimmedName) {
        setError("Please choose an existing friend or enter a friend's name.");
        return;
      }
      targetFriendName = trimmedName;

      // Try to create the friend profile first
      setBusy(true);
      setError("");
      try {
        const createdFriend = await api<Friend>("/api/friends", token!, {
          method: "POST",
          body: JSON.stringify({
            name: trimmedName,
            phone: friendPhone.trim() || undefined,
          }),
        });
        targetFriendId = createdFriend.id;
        setSelectedFriend(createdFriend);
      } catch (e: any) {
        setBusy(false);
        if (e.status === 409 && Array.isArray(e.details?.matches)) {
          setDuplicateMatches(e.details.matches as Friend[]);
          return;
        }
        setError(e?.message || "Could not register friend profile.");
        return;
      }
    }

    const numericAmount = Number(amount);
    if (!amount.trim() || Number.isNaN(numericAmount) || numericAmount <= 0) {
      setError("Please enter a valid loan amount greater than zero.");
      setBusy(false);
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      setError("Please enter a valid due date in YYYY-MM-DD format.");
      setBusy(false);
      return;
    }

    let customOverdueNum: number | undefined = undefined;
    if (customOverdueInput.trim()) {
      const parsedNum = Number(customOverdueInput.trim());
      if (Number.isNaN(parsedNum) || parsedNum < 0) {
        setError("Custom overdue amount must be a valid positive number.");
        setBusy(false);
        return;
      }
      customOverdueNum = parsedNum;
    }

    setBusy(true);
    setError("");
    try {
      await api("/api/loans", token!, {
        method: "POST",
        body: JSON.stringify({
          friendId: targetFriendId,
          friendName: targetFriendName,
          amount: numericAmount,
          dueDate,
          customOverdueAmount: customOverdueNum,
          receipt: selectedReceipt
            ? {
                imageBase64: selectedReceipt.base64,
                contentType: selectedReceipt.contentType,
              }
            : undefined,
        }),
      });

      setFriendName("");
      setFriendPhone("");
      setSelectedFriend(null);
      setFriendSearch("");
      setAmount("");
      setDueDate(addDaysToDate(7));
      setCustomOverdueInput("");
      setSelectedReceipt(null);
      setShowForm(false);
      setSuccessMessage(`Loan of ${rupees(numericAmount)} to ${targetFriendName} recorded!`);
      await refresh();
      if (viewingFriend && viewingFriend.id === targetFriendId) {
        await openFriendProfile(targetFriendId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add loan");
    } finally {
      setBusy(false);
    }
  }

  async function recordLoanRepayment() {
    if (!repayingLoan) return;
    const loan = repayingLoan;
    const remaining = loan.remainingAmount ?? (Number(loan.amount) - (loan.repaidAmount ?? 0));

    let repayAmountVal: number | undefined = undefined;
    if (repaymentAmountInput.trim()) {
      const num = Number(repaymentAmountInput.trim());
      if (Number.isNaN(num) || num <= 0) {
        Alert.alert("Invalid Amount", "Please enter a valid positive repayment amount.");
        return;
      }
      if (num > remaining + 0.001) {
        Alert.alert(
          "Overpayment Blocked",
          `Repayment of ${rupees(num)} exceeds remaining balance of ${rupees(remaining)}.`
        );
        return;
      }
      repayAmountVal = num;
    }

    setBusy(true);
    setRepayingId(loan.id);
    try {
      await api(`/api/loans/${loan.id}/repayments`, token!, {
        method: "POST",
        body: JSON.stringify({
          amount: repayAmountVal,
          note: repaymentNoteInput.trim() || undefined,
        }),
      });

      setSuccessMessage(
        repayAmountVal
          ? `Repayment of ${rupees(repayAmountVal)} recorded!`
          : "Full repayment recorded!"
      );
      setRepayingLoan(null);
      setRepaymentAmountInput("");
      setRepaymentNoteInput("");
      await refresh();
      if (viewingFriend) {
        await openFriendProfile(viewingFriend.id);
      }
    } catch (e: any) {
      Alert.alert("Repayment Error", e?.message || "Could not record repayment.");
    } finally {
      setBusy(false);
      setRepayingId(null);
    }
  }

  function confirmFullRepay(loan: Loan) {
    Alert.alert(
      "Confirm Full Repayment",
      `Mark remaining debt on loan of ${rupees(loan.amount)} as fully repaid?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm Repay",
          style: "default",
          onPress: async () => {
            setBusy(true);
            setRepayingId(loan.id);
            try {
              await api(`/api/loans/${loan.id}/repay`, token!, { method: "PATCH" });
              setSuccessMessage(`Loan marked as fully repaid!`);
              await refresh();
              if (viewingFriend) {
                await openFriendProfile(viewingFriend.id);
              }
            } catch (e: any) {
              Alert.alert("Repay Error", e?.message || "Could not mark loan as repaid.");
            } finally {
              setBusy(false);
              setRepayingId(null);
            }
          },
        },
      ]
    );
  }

  function openSetOverdueModal(loan: Loan) {
    setEditingOverdueLoan(loan);
    setOverdueAmountInput(loan.customOverdueAmount ? loan.customOverdueAmount : "");
    setOverdueModalError("");
  }

  async function saveCustomOverdueAmount(amountVal: string | null) {
    if (!editingOverdueLoan) return;
    setOverdueModalError("");

    let payloadVal: number | null = null;
    if (amountVal !== null && amountVal.trim() !== "") {
      const num = Number(amountVal.trim());
      if (!Number.isFinite(num) || num < 0) {
        setOverdueModalError("Please enter a valid positive amount.");
        return;
      }
      const decimalParts = amountVal.includes(".") ? amountVal.split(".")[1] : "";
      if (decimalParts.length > 2) {
        setOverdueModalError("Amount cannot have more than 2 decimal places.");
        return;
      }
      payloadVal = num;
    }

    setBusy(true);
    try {
      await api(`/api/loans/${editingOverdueLoan.id}/overdue`, token!, {
        method: "PATCH",
        body: JSON.stringify({ customOverdueAmount: payloadVal }),
      });
      setSuccessMessage(
        payloadVal !== null
          ? `Overdue amount updated to ₹${payloadVal.toFixed(2)}`
          : `Overdue amount reset to original loan amount.`
      );
      setEditingOverdueLoan(null);
      await refresh();
      if (viewingFriend) {
        await openFriendProfile(viewingFriend.id);
      }
    } catch (err: any) {
      setOverdueModalError(err?.message || "Failed to update overdue amount.");
    } finally {
      setBusy(false);
    }
  }

  async function openReceiptViewer(loan: Loan) {
    setViewingReceiptLoan(loan);
    setLoadingReceiptImage(true);
    setViewingReceiptUrl(null);
    try {
      const data = await api<{ url: string; contentType?: string }>(
        `/api/loans/${loan.id}/receipt?format=json`,
        token!
      );
      setViewingReceiptUrl(data.url);
    } catch (err: any) {
      Alert.alert("Receipt Error", err?.message || "Could not load receipt photo.");
      setViewingReceiptLoan(null);
    } finally {
      setLoadingReceiptImage(false);
    }
  }

  async function attachReceiptToExistingLoan(loan: Loan) {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.8,
        base64: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const asset = result.assets[0];
      if (!asset.base64) {
        Alert.alert("Upload Error", "Could not read image content.");
        return;
      }

      let contentType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg";
      const uriLower = (asset.uri || "").toLowerCase();
      if (uriLower.endsWith(".png")) contentType = "image/png";
      else if (uriLower.endsWith(".webp")) contentType = "image/webp";

      setBusy(true);
      await api(`/api/loans/${loan.id}/receipt`, token!, {
        method: "POST",
        body: JSON.stringify({
          imageBase64: asset.base64,
          contentType,
        }),
      });

      setSuccessMessage("Receipt attached successfully!");
      await refresh();
      if (viewingFriend) {
        await openFriendProfile(viewingFriend.id);
      }
    } catch (err: any) {
      Alert.alert("Upload Failed", err?.message || "Could not attach receipt.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReceipt(loan: Loan) {
    Alert.alert("Delete Receipt", "Remove receipt photo from this loan?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await api(`/api/loans/${loan.id}/receipt`, token!, { method: "DELETE" });
            setViewingReceiptLoan(null);
            setSuccessMessage("Receipt removed successfully.");
            await refresh();
            if (viewingFriend) {
              await openFriendProfile(viewingFriend.id);
            }
          } catch (err: any) {
            setError(err?.message || "Could not delete receipt.");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
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
          setFriends([]);
          setViewingFriend(null);
          setError("");
          setSuccessMessage("");
        },
      },
    ]);
  }

  const todayStr = getTodayDateString();

  // Friend-level filtering and search
  const filteredFriends = useMemo(() => {
    return friends.filter((friend) => {
      // Filter tab
      if (activeFriendFilter === "OUTSTANDING" && !(friend.outstandingAmount > 0)) return false;
      if (activeFriendFilter === "OVERDUE" && !(friend.overdueAmount > 0)) return false;
      if (activeFriendFilter === "SETTLED" && friend.outstandingAmount > 0) return false;

      // Search query (friend name or phone)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = friend.name.toLowerCase().includes(q);
        const matchesPhone = friend.phone ? friend.phone.toLowerCase().includes(q) : false;
        return matchesName || matchesPhone;
      }
      return true;
    });
  }, [friends, activeFriendFilter, searchQuery]);

  const friendCounts = useMemo(() => {
    let outstanding = 0;
    let overdue = 0;
    let settled = 0;
    for (const f of friends) {
      if (f.overdueAmount > 0) overdue++;
      if (f.outstandingAmount > 0) outstanding++;
      else settled++;
    }
    return { all: friends.length, outstanding, overdue, settled };
  }, [friends]);

  const selectableFriends = useMemo(() => {
    const query = friendSearch.trim().toLowerCase();
    return friends.filter((f) => !query || f.name.toLowerCase().includes(query));
  }, [friends, friendSearch]);

  // Login View
  if (!token) {
    return (
      <View style={styles.safe}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView
          style={[
            styles.loginWrap,
            { paddingTop: insets.top + 22, paddingBottom: insets.bottom + 22 },
          ]}
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
                <Text style={styles.label}>6-DIGIT OTP CODE</Text>
                <TextInput
                  style={[styles.input, styles.otpInput]}
                  value={otp}
                  onChangeText={(t) => {
                    setOtp(t);
                    if (error) setError("");
                  }}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="• • • • • •"
                  placeholderTextColor="#A0AEC0"
                  editable={!busy}
                />
              </>
            )}

            {!!error && <Text style={styles.error}>{error}</Text>}
            {!!successMessage && <Text style={styles.successBanner}>{successMessage}</Text>}

            {!otpSent ? (
              <Pressable
                style={[styles.primary, (busy || !phone.trim()) && styles.buttonDisabled]}
                disabled={busy || !phone.trim()}
                onPress={() => void requestOtpCode()}
              >
                {busy ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text style={styles.primaryText}>Send Mock OTP</Text>
                )}
              </Pressable>
            ) : (
              <>
                <Pressable
                  style={[styles.primary, (busy || otp.trim().length !== 6) && styles.buttonDisabled]}
                  disabled={busy || otp.trim().length !== 6}
                  onPress={() => void verifyOtpCode()}
                >
                  {busy ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text style={styles.primaryText}>Verify & Log In</Text>
                  )}
                </Pressable>

                <View style={styles.otpActionsRow}>
                  <Pressable
                    style={styles.resendButton}
                    disabled={cooldown > 0 || busy}
                    onPress={() => void requestOtpCode()}
                  >
                    <Text style={[styles.link, cooldown > 0 && styles.linkMuted]}>
                      {cooldown > 0 ? `Resend OTP in ${cooldown}s` : "Resend OTP"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.changePhoneButton}
                    disabled={busy}
                    onPress={() => {
                      setOtpSent(false);
                      setOtp("");
                      setError("");
                    }}
                  >
                    <Text style={styles.link}>Change Number</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>

          <View style={styles.demoNoteCard}>
            <Text style={styles.demoNoteTitle}>💡 Internship Demo Mode Active</Text>
            <Text style={styles.demoNoteBody}>
              Mock OTP authentication is enabled. Check your backend terminal output to view the 6-digit verification code.
            </Text>
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // Authenticated Dashboard View
  return (
    <View style={styles.safe}>
      <StatusBar style="dark" />
      <View style={[styles.topbar, { paddingTop: insets.top + 12 }]}>
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
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor="#2457E6" />
        }
      >
        {/* Global Financial Summary Card */}
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

        {!!error && <Text style={styles.errorBanner}>{error}</Text>}
        {!!successMessage && <Text style={styles.successBanner}>{successMessage}</Text>}

        {/* Section Header with Add Loan Button */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Friends ({friends.length})</Text>
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

            <Text style={styles.label}>SELECT OR ADD FRIEND</Text>
            {selectedFriend ? (
              <View style={styles.selectedFriend}>
                <View style={styles.selectedFriendCopy}>
                  <Text style={styles.selectedFriendName}>{selectedFriend.name}</Text>
                  {selectedFriend.phone ? (
                    <Text style={styles.selectedFriendPhone}>📞 {selectedFriend.phone}</Text>
                  ) : null}
                  <Text style={styles.selectedFriendBalance}>
                    Current Outstanding: {rupees(selectedFriend.outstandingAmount)}
                  </Text>
                </View>
                <Pressable onPress={() => setSelectedFriend(null)}>
                  <Text style={styles.link}>Change</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  value={friendSearch}
                  onChangeText={setFriendSearch}
                  placeholder="🔍 Search existing friends..."
                  placeholderTextColor="#A0AEC0"
                />
                {selectableFriends.slice(0, 4).map((f) => (
                  <Pressable
                    key={f.id}
                    style={styles.friendOption}
                    onPress={() => {
                      setSelectedFriend(f);
                      setFriendSearch("");
                    }}
                  >
                    <View>
                      <Text style={styles.friendOptionName}>{f.name}</Text>
                      {f.phone ? <Text style={styles.friendOptionPhone}>{f.phone}</Text> : null}
                    </View>
                    <Text style={styles.friendOptionBalance}>
                      Outstanding: {rupees(f.outstandingAmount)}
                    </Text>
                  </Pressable>
                ))}
                <Text style={styles.orLabel}>OR ADD NEW FRIEND PROFILE</Text>
                <TextInput
                  style={styles.input}
                  value={friendName}
                  onChangeText={setFriendName}
                  placeholder="Friend Name (e.g. Pooja Verma)"
                  placeholderTextColor="#A0AEC0"
                  maxLength={80}
                />
                <TextInput
                  style={styles.input}
                  value={friendPhone}
                  onChangeText={setFriendPhone}
                  placeholder="Phone number (optional, e.g. 9123456789)"
                  placeholderTextColor="#A0AEC0"
                  keyboardType="phone-pad"
                  maxLength={15}
                />
              </>
            )}

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

            {/* Optional Custom Overdue Override */}
            <Text style={styles.label}>CUSTOM OVERDUE AMOUNT (₹, OPTIONAL)</Text>
            <TextInput
              style={styles.input}
              value={customOverdueInput}
              onChangeText={setCustomOverdueInput}
              placeholder="Leave blank to use full loan amount"
              placeholderTextColor="#A0AEC0"
              keyboardType="decimal-pad"
            />

            {/* Receipt Photo Attachment */}
            <Text style={styles.label}>RECEIPT PHOTO (OPTIONAL)</Text>
            {selectedReceipt ? (
              <View style={styles.receiptPreviewContainer}>
                <Image source={{ uri: selectedReceipt.uri }} style={styles.receiptThumbnail} />
                <View style={styles.receiptDetails}>
                  <Text style={styles.receiptFileName} numberOfLines={1}>
                    {selectedReceipt.fileName}
                  </Text>
                  <Text style={styles.receiptFileSize}>
                    {selectedReceipt.contentType.replace("image/", "").toUpperCase()} •{" "}
                    {formatFileSize(selectedReceipt.fileSize)}
                  </Text>
                </View>
                <Pressable style={styles.removeReceiptButton} onPress={removeSelectedReceipt}>
                  <Text style={styles.removeReceiptText}>✕ Remove</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable style={styles.attachReceiptButton} onPress={() => void chooseReceiptPhoto()}>
                <Text style={styles.attachReceiptText}>📷 Choose Receipt Photo</Text>
              </Pressable>
            )}

            <Pressable
              style={[styles.primary, busy && styles.buttonDisabled]}
              disabled={busy}
              onPress={() => void handleAddLoan()}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={styles.primaryText}>Save Loan</Text>
              )}
            </Pressable>
          </View>
        )}

        {/* Search Input for Friends */}
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="🔍 Search friends by name or phone..."
            placeholderTextColor="#98A2B3"
          />
        </View>

        {/* Friend Filter Chips */}
        <View style={styles.filterRow}>
          <Pressable
            style={[styles.filterChip, activeFriendFilter === "ALL" && styles.filterChipActive]}
            onPress={() => setActiveFriendFilter("ALL")}
          >
            <Text
              style={[styles.filterChipText, activeFriendFilter === "ALL" && styles.filterChipTextActive]}
            >
              All ({friendCounts.all})
            </Text>
          </Pressable>

          <Pressable
            style={[styles.filterChip, activeFriendFilter === "OUTSTANDING" && styles.filterChipActive]}
            onPress={() => setActiveFriendFilter("OUTSTANDING")}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFriendFilter === "OUTSTANDING" && styles.filterChipTextActive,
              ]}
            >
              Outstanding ({friendCounts.outstanding})
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.filterChip,
              activeFriendFilter === "OVERDUE" && styles.filterChipActiveOverdue,
            ]}
            onPress={() => setActiveFriendFilter("OVERDUE")}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFriendFilter === "OVERDUE" && styles.filterChipTextActiveOverdue,
              ]}
            >
              Overdue ({friendCounts.overdue})
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.filterChip,
              activeFriendFilter === "SETTLED" && styles.filterChipActiveRepaid,
            ]}
            onPress={() => setActiveFriendFilter("SETTLED")}
          >
            <Text
              style={[
                styles.filterChipText,
                activeFriendFilter === "SETTLED" && styles.filterChipTextActiveRepaid,
              ]}
            >
              Settled ({friendCounts.settled})
            </Text>
          </Pressable>
        </View>

        {/* One Entry Per Friend List */}
        {filteredFriends.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>👥</Text>
            <Text style={styles.emptyTitle}>
              {friends.length === 0 ? "No friend profiles yet" : "No matching friends found"}
            </Text>
            <Text style={styles.emptySubtitle}>
              {friends.length === 0
                ? "Tap '+ Add Loan' above to create your first friend profile and record a loan."
                : "Try adjusting your search query or status filter."}
            </Text>
          </View>
        ) : (
          <FlatList
            scrollEnabled={false}
            data={filteredFriends}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const isOverdue = item.overdueAmount > 0;
              const isSettled = item.outstandingAmount === 0 && item.loansCount > 0;
              return (
                <Pressable
                  style={[
                    styles.friendCard,
                    isOverdue && styles.friendCardOverdue,
                    isSettled && styles.friendCardSettled,
                  ]}
                  onPress={() => void openFriendProfile(item.id)}
                >
                  <View style={styles.friendCardContent}>
                    <View
                      style={[
                        styles.avatar,
                        isOverdue && styles.avatarOverdue,
                        isSettled && styles.avatarRepaid,
                      ]}
                    >
                      <Text
                        style={[
                          styles.avatarText,
                          isOverdue && styles.avatarTextOverdue,
                          isSettled && styles.avatarTextRepaid,
                        ]}
                      >
                        {item.name.trim().charAt(0).toUpperCase()}
                      </Text>
                    </View>

                    <View style={styles.friendInfoWrap}>
                      <View style={styles.nameRow}>
                        <Text style={styles.friendNameText}>{item.name}</Text>
                        {isOverdue && (
                          <View style={styles.overdueBadge}>
                            <Text style={styles.overdueBadgeText}>⚠️ Overdue</Text>
                          </View>
                        )}
                        {isSettled && (
                          <View style={styles.settledBadge}>
                            <Text style={styles.settledBadgeText}>✓ Settled</Text>
                          </View>
                        )}
                      </View>

                      {item.phone ? (
                        <Text style={styles.friendPhoneText}>📞 {item.phone}</Text>
                      ) : null}

                      <View style={styles.metaRow}>
                        <Text style={styles.loansCountText}>
                          {item.loansCount} {item.loansCount === 1 ? "loan" : "loans"}
                        </Text>
                        <Text style={styles.metaBullet}>•</Text>
                        <Text style={styles.activityDateText}>
                          Activity: {formatActivityDate(item.latestActivityDate || item.updatedAt || item.createdAt)}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.friendBalanceColumn}>
                      <Text style={styles.balanceLabel}>OUTSTANDING</Text>
                      <Text
                        style={[
                          styles.friendOutstandingAmount,
                          isOverdue && styles.amountOverdue,
                          isSettled && styles.amountSettled,
                        ]}
                      >
                        {rupees(item.outstandingAmount)}
                      </Text>
                      {isOverdue && (
                        <Text style={styles.friendOverdueSubtext}>
                          {rupees(item.overdueAmount)} overdue
                        </Text>
                      )}
                      <Text style={styles.tapToViewText}>Tap for history ›</Text>
                    </View>
                  </View>
                </Pressable>
              );
            }}
          />
        )}

        <Pressable style={styles.refresh} onPress={() => void refresh()}>
          <Text style={styles.refreshText}>↻ Tap to refresh</Text>
        </Pressable>
      </ScrollView>

      {/* Friend Detail Screen (Modal) */}
      <Modal
        visible={viewingFriend !== null}
        animationType="slide"
        onRequestClose={() => setViewingFriend(null)}
      >
        <View style={styles.modalScreen}>
          <View style={[styles.detailHeader, { paddingTop: insets.top + 8 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.detailTitle}>{viewingFriend?.name}</Text>
              <Text style={styles.detailSubtitle}>
                {viewingFriend?.phone ? `📞 ${viewingFriend.phone} • ` : ""}
                Member since {formatActivityDate(viewingFriend?.createdAt)}
              </Text>
            </View>
            <Pressable style={styles.modalCloseButton} onPress={() => setViewingFriend(null)}>
              <Text style={styles.modalCloseText}>✕</Text>
            </Pressable>
          </View>

          {loadingFriend || !viewingFriend ? (
            <ActivityIndicator color="#1F4FD6" style={styles.profileLoading} />
          ) : (
            <ScrollView contentContainerStyle={[styles.profileContent, { paddingBottom: insets.bottom + 40 }]}>
              {/* Friend-Level Financial Summary Card */}
              <View style={styles.friendSummaryHero}>
                <View style={styles.friendHeroRow}>
                  <Text style={styles.friendHeroLabel}>OUTSTANDING BALANCE</Text>
                  {viewingFriend.overdueAmount > 0 && (
                    <View style={styles.overdueBadge}>
                      <Text style={styles.overdueBadgeText}>
                        ⚠️ {rupees(viewingFriend.overdueAmount)} Overdue
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.friendHeroBalance}>
                  {rupees(viewingFriend.outstandingAmount)}
                </Text>

                <View style={styles.friendHeroGrid}>
                  <View style={styles.statBox}>
                    <Text style={styles.friendStatLabel}>TOTAL LENT</Text>
                    <Text style={styles.friendStatValue}>{rupees(viewingFriend.totalLent)}</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statBox}>
                    <Text style={styles.friendStatLabel}>TOTAL REPAID</Text>
                    <Text style={styles.friendStatValueRepaid}>
                      {rupees(viewingFriend.totalRepaid)}
                    </Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statBox}>
                    <Text style={styles.friendStatLabel}>TOTAL LOANS</Text>
                    <Text style={styles.friendStatValue}>{viewingFriend.loansCount}</Text>
                  </View>
                </View>
              </View>

              {/* Clear Action: Add Loan to this friend */}
              <Pressable
                style={styles.addLoanToFriendBtn}
                onPress={() => {
                  setSelectedFriend(viewingFriend);
                  setViewingFriend(null);
                  setShowForm(true);
                }}
              >
                <Text style={styles.addLoanToFriendText}>
                  + Add Loan to {viewingFriend.name}
                </Text>
              </Pressable>

              <Text style={styles.historyTitle}>
                Complete Loan & Repayment History ({viewingFriend.loans.length})
              </Text>

              {viewingFriend.loans.length === 0 ? (
                <View style={styles.emptyHistoryBox}>
                  <Text style={styles.emptyHistoryText}>
                    No loans recorded for this friend yet.
                  </Text>
                </View>
              ) : (
                viewingFriend.loans.map((loan) => {
                  const isOverdue = loan.status === "PENDING" && loan.dueDate < todayStr;
                  const isRepaid = loan.status === "REPAID";
                  const remaining =
                    loan.remainingAmount ??
                    (isRepaid ? 0 : Number(loan.amount) - (loan.repaidAmount ?? 0));

                  return (
                    <View
                      key={loan.id}
                      style={[
                        styles.loanDetailCard,
                        isOverdue && styles.overdueCard,
                        isRepaid && styles.repaidCard,
                      ]}
                    >
                      <View style={styles.loanDetailTop}>
                        <View style={{ flex: 1 }}>
                          <View style={styles.nameRow}>
                            <Text style={styles.loanDetailAmount}>{rupees(loan.amount)}</Text>
                            <View
                              style={[
                                styles.statusBadge,
                                isOverdue && styles.badgeOverdue,
                                isRepaid && styles.badgeRepaid,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.statusText,
                                  isOverdue && styles.statusTextOverdue,
                                  isRepaid && styles.statusTextRepaid,
                                ]}
                              >
                                {isRepaid ? "✓ Repaid" : isOverdue ? "⚠️ Overdue" : "● Pending"}
                              </Text>
                            </View>
                            {loan.hasReceipt && (
                              <Pressable
                                style={styles.receiptPill}
                                onPress={() => void openReceiptViewer(loan)}
                              >
                                <Text style={styles.receiptPillText}>📷 Receipt</Text>
                              </Pressable>
                            )}
                          </View>

                          <Text style={styles.loanDetailDates}>
                            Lent: {formatActivityDate(loan.createdAt)} •{" "}
                            {isOverdue ? `⚠️ Due: ${loan.dueDate}` : `Due: ${loan.dueDate}`}
                          </Text>

                          {!isRepaid && (
                            <Text style={styles.loanRemainingText}>
                              Remaining:{" "}
                              <Text style={{ fontWeight: "900", color: isOverdue ? "#D92D20" : "#101828" }}>
                                {rupees(remaining)}
                              </Text>
                            </Text>
                          )}

                          {isOverdue && loan.customOverdueAmount && (
                            <Text style={styles.customOverdueText}>
                              Custom Overdue: {rupees(loan.customOverdueAmount)}
                            </Text>
                          )}
                        </View>
                      </View>

                      {/* Repayment Transactions List */}
                      {!!loan.repayments?.length && (
                        <View style={styles.repaymentSection}>
                          <Text style={styles.repaymentSectionTitle}>Repayment Transactions:</Text>
                          {loan.repayments.map((rep) => (
                            <View key={rep.id} style={styles.repaymentRow}>
                              <Text style={styles.repaymentRowAmount}>+ {rupees(rep.amount)}</Text>
                              <Text style={styles.repaymentRowDate}>
                                on {formatActivityDate(rep.repaidAt)}
                                {rep.note ? ` • "${rep.note}"` : ""}
                              </Text>
                            </View>
                          ))}
                        </View>
                      )}

                      {/* Action buttons on this loan */}
                      {!isRepaid && (
                        <View style={styles.loanActionsBar}>
                          <Pressable
                            style={styles.recordRepayBtn}
                            onPress={() => {
                              setRepayingLoan(loan);
                              setRepaymentAmountInput(remaining.toFixed(2));
                              setRepaymentNoteInput("");
                            }}
                          >
                            <Text style={styles.recordRepayBtnText}>Record Repay</Text>
                          </Pressable>

                          <Pressable
                            style={styles.fullRepayBtn}
                            onPress={() => confirmFullRepay(loan)}
                          >
                            <Text style={styles.fullRepayBtnText}>Full Repay</Text>
                          </Pressable>

                          {!loan.hasReceipt && (
                            <Pressable
                              style={styles.addReceiptBtn}
                              onPress={() => void attachReceiptToExistingLoan(loan)}
                            >
                              <Text style={styles.addReceiptBtnText}>+ Receipt</Text>
                            </Pressable>
                          )}

                          {isOverdue && (
                            <Pressable
                              style={styles.setOverdueBtn}
                              onPress={() => openSetOverdueModal(loan)}
                            >
                              <Text style={styles.setOverdueBtnText}>
                                {loan.customOverdueAmount ? "✏️ Overdue" : "+ Overdue"}
                              </Text>
                            </Pressable>
                          )}
                        </View>
                      )}
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* Record Repayment Modal */}
      <Modal
        visible={repayingLoan !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRepayingLoan(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Record Repayment</Text>
                <Text style={styles.modalSubtitle}>
                  {repayingLoan?.friendName} • Total Loan: {rupees(repayingLoan?.amount || 0)}
                </Text>
              </View>
              <Pressable
                style={styles.modalCloseButton}
                onPress={() => setRepayingLoan(null)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </Pressable>
            </View>

            <View style={{ padding: 16 }}>
              <Text style={styles.label}>REPAYMENT AMOUNT (₹)</Text>
              <TextInput
                style={styles.input}
                value={repaymentAmountInput}
                onChangeText={setRepaymentAmountInput}
                placeholder="Enter amount (partial or full)"
                placeholderTextColor="#A0AEC0"
                keyboardType="decimal-pad"
              />

              <Text style={styles.label}>NOTE / REMARKS (OPTIONAL)</Text>
              <TextInput
                style={styles.input}
                value={repaymentNoteInput}
                onChangeText={setRepaymentNoteInput}
                placeholder="e.g. UPI installment, cash payment"
                placeholderTextColor="#A0AEC0"
                maxLength={200}
              />
            </View>

            <View style={styles.modalFooter}>
              <Pressable
                style={styles.modalDeleteButton}
                onPress={() => setRepayingLoan(null)}
              >
                <Text style={styles.modalDeleteText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalDoneButton, busy && styles.buttonDisabled]}
                disabled={busy}
                onPress={() => void recordLoanRepayment()}
              >
                {busy ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text style={styles.modalDoneText}>Submit Repayment</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Duplicate Conflict Resolution Modal */}
      <Modal
        visible={duplicateMatches !== null && duplicateMatches.length > 0}
        transparent
        animationType="fade"
        onRequestClose={() => setDuplicateMatches(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Friend Profile Already Exists</Text>
                <Text style={styles.modalSubtitle}>
                  A matching profile was found. Select it to prevent accidental duplicates:
                </Text>
              </View>
              <Pressable
                style={styles.modalCloseButton}
                onPress={() => setDuplicateMatches(null)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </Pressable>
            </View>

            <View style={{ padding: 12 }}>
              {duplicateMatches?.map((match) => (
                <View key={match.id} style={styles.duplicateMatchBox}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.duplicateMatchName}>{match.name}</Text>
                    {match.phone ? (
                      <Text style={styles.duplicateMatchPhone}>📞 {match.phone}</Text>
                    ) : null}
                    <Text style={styles.duplicateMatchBalance}>
                      Outstanding: {rupees(match.outstandingAmount)}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.useProfileBtn}
                    onPress={() => {
                      setSelectedFriend(match);
                      setFriendName("");
                      setFriendPhone("");
                      setDuplicateMatches(null);
                    }}
                  >
                    <Text style={styles.useProfileBtnText}>Use Profile</Text>
                  </Pressable>
                </View>
              ))}
            </View>

            <View style={styles.modalFooter}>
              <Pressable
                style={styles.modalDeleteButton}
                onPress={() => setDuplicateMatches(null)}
              >
                <Text style={styles.modalDeleteText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Receipt Viewer Modal */}
      <Modal
        visible={viewingReceiptLoan !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setViewingReceiptLoan(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Receipt Attachment</Text>
                <Text style={styles.modalSubtitle}>
                  {viewingReceiptLoan?.friendName} · {rupees(viewingReceiptLoan?.amount || 0)}
                </Text>
              </View>
              <Pressable
                style={styles.modalCloseButton}
                onPress={() => setViewingReceiptLoan(null)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.modalImageContainer}>
              {loadingReceiptImage ? (
                <View style={styles.modalLoadingBox}>
                  <ActivityIndicator size="large" color="#1F4FD6" />
                  <Text style={styles.modalLoadingText}>Loading receipt...</Text>
                </View>
              ) : viewingReceiptUrl ? (
                <Image
                  source={{ uri: viewingReceiptUrl }}
                  style={styles.modalReceiptImage}
                  resizeMode="contain"
                />
              ) : (
                <Text style={styles.modalErrorText}>Could not load receipt photo.</Text>
              )}
            </View>

            <View style={styles.modalFooter}>
              {viewingReceiptLoan && (
                <Pressable
                  style={styles.modalDeleteButton}
                  onPress={() => void deleteReceipt(viewingReceiptLoan)}
                >
                  <Text style={styles.modalDeleteText}>🗑️ Delete Receipt</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.modalDoneButton}
                onPress={() => setViewingReceiptLoan(null)}
              >
                <Text style={styles.modalDoneText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Custom Overdue Amount Modal */}
      <Modal
        visible={editingOverdueLoan !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditingOverdueLoan(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Set Overdue Amount</Text>
                <Text style={styles.modalSubtitle}>
                  {editingOverdueLoan?.friendName} · Original: {rupees(editingOverdueLoan?.amount || 0)}
                </Text>
              </View>
              <Pressable
                style={styles.modalCloseButton}
                onPress={() => setEditingOverdueLoan(null)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </Pressable>
            </View>

            <View style={{ padding: 16 }}>
              <Text style={styles.overdueModalHint}>
                Specify a customized overdue amount (e.g. adding a late fee, penalty, or negotiated reduction). Leaving blank or resetting uses the original loan amount.
              </Text>

              <Text style={styles.label}>CUSTOM OVERDUE AMOUNT (₹)</Text>
              <TextInput
                style={styles.input}
                value={overdueAmountInput}
                onChangeText={(t) => {
                  setOverdueAmountInput(t);
                  if (overdueModalError) setOverdueModalError("");
                }}
                placeholder={`Original amount: ${editingOverdueLoan?.amount || 0}`}
                placeholderTextColor="#A0AEC0"
                keyboardType="decimal-pad"
              />

              {!!overdueModalError && (
                <Text style={[styles.error, { marginTop: 4 }]}>{overdueModalError}</Text>
              )}
            </View>

            <View style={styles.modalFooter}>
              <Pressable
                style={styles.modalDeleteButton}
                onPress={() => void saveCustomOverdueAmount(null)}
              >
                <Text style={styles.modalDeleteText}>↺ Reset to Original</Text>
              </Pressable>
              <Pressable
                style={styles.modalDoneButton}
                onPress={() => void saveCustomOverdueAmount(overdueAmountInput)}
              >
                <Text style={styles.modalDoneText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F7F9FC" },
  loginWrap: { flex: 1, justifyContent: "center", paddingHorizontal: 22 },
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
  content: { paddingHorizontal: 18, paddingTop: 6 },
  selectedFriend: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#B2DDFF",
    borderRadius: 12,
    padding: 12,
    marginBottom: 6,
  },
  selectedFriendCopy: { flex: 1 },
  selectedFriendName: { color: "#101828", fontWeight: "800", fontSize: 15 },
  selectedFriendPhone: { color: "#667085", fontSize: 12, marginTop: 2 },
  selectedFriendBalance: { color: "#175CD3", fontSize: 12, fontWeight: "700", marginTop: 4 },
  friendOption: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#EAECF0",
  },
  friendOptionName: { color: "#101828", fontWeight: "700", fontSize: 14 },
  friendOptionPhone: { color: "#667085", fontSize: 11, marginTop: 1 },
  friendOptionBalance: { color: "#175CD3", fontSize: 12, fontWeight: "700" },
  orLabel: { color: "#98A2B3", fontSize: 10, fontWeight: "800", letterSpacing: 0.7, marginTop: 12, marginBottom: 4 },
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

  // Receipt Photo Styles in Form
  attachReceiptButton: {
    backgroundColor: "#F8F9FC",
    borderWidth: 1,
    borderColor: "#D0D5DD",
    borderStyle: "dashed",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
    marginBottom: 8,
  },
  attachReceiptText: { color: "#1F4FD6", fontSize: 13, fontWeight: "700" },
  receiptPreviewContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#B2DDFF",
    borderRadius: 12,
    padding: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  receiptThumbnail: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: "#EAECF0",
  },
  receiptDetails: { flex: 1, marginLeft: 10 },
  receiptFileName: { fontSize: 13, fontWeight: "700", color: "#101828" },
  receiptFileSize: { fontSize: 11, color: "#667085", marginTop: 2 },
  removeReceiptButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#FEE4E2",
  },
  removeReceiptText: { color: "#B42318", fontSize: 12, fontWeight: "700" },

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

  // Friend Card Styles (Dashboard - One entry per friend)
  friendCard: {
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
  friendCardOverdue: {
    borderColor: "#FDA29B",
    backgroundColor: "#FFFBFA",
  },
  friendCardSettled: {
    borderColor: "#ABEFC6",
    backgroundColor: "#F6FEF9",
  },
  friendCardContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatar: {
    width: 46,
    height: 46,
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
  friendInfoWrap: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  friendNameText: { fontSize: 16, color: "#101828", fontWeight: "800", marginRight: 6 },
  friendPhoneText: { fontSize: 12, color: "#667085", marginTop: 2 },
  metaRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  loansCountText: { fontSize: 11, color: "#475467", fontWeight: "700" },
  metaBullet: { fontSize: 11, color: "#98A2B3", marginHorizontal: 5 },
  activityDateText: { fontSize: 11, color: "#667085" },
  overdueBadge: {
    backgroundColor: "#FEE4E2",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  overdueBadgeText: { fontSize: 10, color: "#B42318", fontWeight: "800" },
  settledBadge: {
    backgroundColor: "#D1FADF",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  settledBadgeText: { fontSize: 10, color: "#027A48", fontWeight: "800" },
  friendBalanceColumn: { alignItems: "flex-end", marginLeft: 10 },
  balanceLabel: { fontSize: 9, fontWeight: "800", color: "#98A2B3", letterSpacing: 0.6 },
  friendOutstandingAmount: { fontSize: 16, fontWeight: "900", color: "#101828", marginTop: 2 },
  amountOverdue: { color: "#D92D20" },
  amountSettled: { color: "#079455" },
  friendOverdueSubtext: { fontSize: 11, color: "#D92D20", fontWeight: "700", marginTop: 2 },
  tapToViewText: { fontSize: 10, color: "#1F4FD6", fontWeight: "700", marginTop: 4 },

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

  // Friend Detail Screen Styles (Modal)
  modalScreen: { flex: 1, backgroundColor: "#F7F9FC" },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
    backgroundColor: "white",
    borderBottomWidth: 1,
    borderBottomColor: "#EAECF0",
  },
  detailTitle: { fontSize: 22, fontWeight: "900", color: "#101828" },
  detailSubtitle: { fontSize: 12, color: "#667085", marginTop: 2 },
  profileLoading: { marginTop: 40 },
  profileContent: { padding: 18 },

  friendSummaryHero: {
    backgroundColor: "#163AB0",
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
  },
  friendHeroRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  friendHeroLabel: { color: "#C8D5FB", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  friendHeroBalance: { color: "white", fontSize: 30, fontWeight: "900", marginTop: 4, marginBottom: 14 },
  friendHeroGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.15)",
    paddingTop: 12,
  },
  friendStatLabel: { color: "#B8CBF8", fontSize: 9, fontWeight: "800", letterSpacing: 0.6 },
  friendStatValue: { color: "white", fontSize: 14, fontWeight: "800", marginTop: 2 },
  friendStatValueRepaid: { color: "#7CE8B8", fontSize: 14, fontWeight: "800", marginTop: 2 },

  addLoanToFriendBtn: {
    backgroundColor: "#1F4FD6",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: 18,
  },
  addLoanToFriendText: { color: "white", fontWeight: "800", fontSize: 14 },

  historyTitle: { color: "#101828", fontSize: 17, fontWeight: "800", marginBottom: 12 },
  emptyHistoryBox: {
    padding: 24,
    backgroundColor: "white",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#EAECF0",
    alignItems: "center",
  },
  emptyHistoryText: { color: "#667085", fontSize: 13 },

  loanDetailCard: {
    backgroundColor: "white",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#EAECF0",
  },
  overdueCard: {
    borderColor: "#FDA29B",
    backgroundColor: "#FFFBFA",
  },
  repaidCard: {
    borderColor: "#ABEFC6",
    backgroundColor: "#F6FEF9",
  },
  loanDetailTop: { flexDirection: "row", alignItems: "flex-start" },
  loanDetailAmount: { fontSize: 18, fontWeight: "900", color: "#101828", marginRight: 8 },
  loanDetailDates: { fontSize: 12, color: "#667085", marginTop: 4 },
  loanRemainingText: { fontSize: 13, color: "#475467", marginTop: 4 },
  customOverdueText: { fontSize: 11, color: "#D92D20", fontWeight: "800", marginTop: 2 },

  receiptPill: {
    backgroundColor: "#EFF8FF",
    borderColor: "#B2DDFF",
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 6,
  },
  receiptPillText: { fontSize: 10, color: "#175CD3", fontWeight: "800" },

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

  repaymentSection: {
    borderTopWidth: 1,
    borderTopColor: "#EAECF0",
    marginTop: 10,
    paddingTop: 8,
  },
  repaymentSectionTitle: { fontSize: 11, fontWeight: "800", color: "#475467", marginBottom: 4 },
  repaymentRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  repaymentRowAmount: { fontSize: 12, fontWeight: "800", color: "#079455" },
  repaymentRowDate: { fontSize: 11, color: "#667085" },

  loanActionsBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#F2F4F7",
    marginTop: 10,
    paddingTop: 10,
  },
  recordRepayBtn: {
    backgroundColor: "#1F4FD6",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    marginRight: 6,
  },
  recordRepayBtnText: { color: "white", fontSize: 11, fontWeight: "800" },
  fullRepayBtn: {
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#B2DDFF",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginRight: 6,
  },
  fullRepayBtnText: { color: "#175CD3", fontSize: 11, fontWeight: "800" },
  addReceiptBtn: {
    backgroundColor: "#F2F4F7",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginRight: 6,
  },
  addReceiptBtnText: { color: "#344054", fontWeight: "700", fontSize: 11 },
  setOverdueBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#FEF3F2",
    borderColor: "#FECDCA",
    borderWidth: 1,
  },
  setOverdueBtnText: { color: "#B42318", fontWeight: "700", fontSize: 11 },

  // Modals generic
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  modalCard: {
    width: "100%",
    maxWidth: 480,
    backgroundColor: "white",
    borderRadius: 20,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 14,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: "900", color: "#101828" },
  modalSubtitle: { fontSize: 13, color: "#667085", marginTop: 2 },
  modalCloseButton: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: "#F2F4F7",
  },
  modalCloseText: { fontSize: 16, fontWeight: "800", color: "#475467" },
  modalImageContainer: {
    width: "100%",
    height: 320,
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#EAECF0",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  modalReceiptImage: { width: "100%", height: "100%" },
  modalLoadingBox: { alignItems: "center" },
  modalLoadingText: { marginTop: 10, fontSize: 13, color: "#667085", fontWeight: "600" },
  modalErrorText: { fontSize: 13, color: "#D92D20", fontWeight: "600" },
  modalFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
  },
  modalDeleteButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#FEE4E2",
  },
  modalDeleteText: { color: "#B42318", fontSize: 12, fontWeight: "800" },
  modalDoneButton: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#1F4FD6",
    marginLeft: "auto",
  },
  modalDoneText: { color: "white", fontSize: 13, fontWeight: "800" },
  overdueModalHint: { fontSize: 13, color: "#475467", lineHeight: 18, marginBottom: 14 },

  // Duplicate Match Box
  duplicateMatchBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#B2DDFF",
    borderRadius: 12,
    padding: 12,
    marginVertical: 4,
  },
  duplicateMatchName: { fontSize: 15, fontWeight: "800", color: "#101828" },
  duplicateMatchPhone: { fontSize: 12, color: "#667085", marginTop: 1 },
  duplicateMatchBalance: { fontSize: 12, color: "#175CD3", fontWeight: "700", marginTop: 2 },
  useProfileBtn: {
    backgroundColor: "#1F4FD6",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    marginLeft: 8,
  },
  useProfileBtnText: { color: "white", fontSize: 12, fontWeight: "800" },
});
