import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Logo } from "../components/icons";
import {
  Button,
  Card,
  Chip,
  Field,
  Muted,
  Note,
  Screen,
  Title,
  colors,
  fonts,
} from "../components/ui";
import { type AuthPayload, api, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import type { Challenge } from "../lib/types";

type Mode = "login" | "college" | "outsider" | "verify" | "forgot" | "reset";
type Department = { id: string; name: string; code: string };
type Program = {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  foundationDepartmentId: string | null;
  foundationYears: number;
  durationYears: number;
};

export function AuthScreen() {
  const { signIn, config } = useSession();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [rollNumber, setRollNumber] = useState("");
  const [programId, setProgramId] = useState("");
  const [studyYear, setStudyYear] = useState("");
  const [graduationYear, setGraduationYear] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [departmentId, setDepartmentId] = useState("");
  const [departments, setDepartments] = useState<Department[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [otp, setOtp] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === "college" && departments.length === 0)
      api<{ items: Department[] }>("/auth/departments")
        .then((d) => setDepartments(d.items))
        .catch((e) => setError(errorMessage(e)));
  }, [mode, departments.length]);

  useEffect(() => {
    if (mode === "college" && programs.length === 0)
      api<{ items: Program[] }>("/auth/programs")
        .then((result) => setPrograms(result.items))
        .catch((e) => setError(errorMessage(e)));
  }, [mode, programs.length]);

  function go(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword("");
    setOtp("");
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const normalized = email.trim().toLowerCase();

  async function submit() {
    await run(async () => {
      if (mode === "login") {
        const result = await api<AuthPayload>("/auth/login", {
          email: normalized,
          password,
          client: "mobile",
          deviceLabel: "CampusOps mobile",
        });
        await signIn(result);
      } else if (mode === "college" || mode === "outsider") {
        const selectedProgram = programs.find((p) => p.id === programId);
        if (!selectedProgram && mode === "college") throw new Error("Choose your programme.");
        if (
          selectedProgram &&
          selectedProgram.foundationYears > 0 &&
          !studyYear &&
          mode === "college"
        )
          throw new Error("Choose your year of study.");
        if (
          selectedProgram &&
          !selectedProgram.departmentId &&
          !selectedProgram.foundationDepartmentId &&
          !departmentId &&
          mode === "college"
        )
          throw new Error(
            "This programme has no department yet. Choose one or contact your administrator.",
          );
        if (mode === "college" && graduationYear && !/^20\d{2}$/.test(graduationYear))
          throw new Error("Enter a valid four-digit graduation year.");
        const trimmedPhone = phone.trim();
        if (trimmedPhone && !/^[+\d][\d\s-]{6,19}$/.test(trimmedPhone))
          throw new Error("Enter a phone number with 7 to 15 digits, or leave it blank.");
        const body = {
          email: normalized,
          password,
          fullName: fullName.trim(),
          ...(trimmedPhone ? { phone: trimmedPhone } : {}),
          institutionName:
            mode === "college" ? (config?.institutionName ?? "Campus") : institutionName.trim(),
          client: "mobile",
          ...(mode === "college"
            ? {
                rollNumber: rollNumber.trim(),
                programId: selectedProgram?.id,
                studyYear: studyYear ? Number(studyYear) : undefined,
                graduationYear: graduationYear ? Number(graduationYear) : undefined,
                departmentId:
                  selectedProgram?.departmentId ??
                  selectedProgram?.foundationDepartmentId ??
                  departmentId,
              }
            : {}),
        };
        const result = await api<{ verification: Challenge }>(`/auth/register/${mode}`, body, {
          idempotencyKey: `register-${normalized}-${Date.now()}`,
        });
        setChallenge(result.verification);
        setPassword("");
        setMode("verify");
        setNotice(
          result.verification.delivery === "DEMO"
            ? "Demo email mode: use the code shown below."
            : "Enter the code sent to your email.",
        );
      } else if (mode === "verify") {
        if (!challenge) throw new Error("Request a verification code first.");
        await api("/auth/verify-email", { challengeId: challenge.challengeId, otp: otp.trim() });
        setMode("login");
        setOtp("");
        setNotice("Email verified. Sign in to continue.");
      } else if (mode === "forgot") {
        const result = await api<{ verification?: Challenge }>("/auth/forgot-password", {
          email: normalized,
        });
        setChallenge(result.verification ?? null);
        setMode("reset");
        setNotice("If that account exists, a reset code has been sent.");
      } else {
        await api("/auth/reset-password", {
          email: normalized,
          otp: otp.trim(),
          newPassword: password,
        });
        setMode("login");
        setPassword("");
        setOtp("");
        setNotice("Password set. Sign in with your new password.");
      }
    });
  }

  const registering = mode === "college" || mode === "outsider";
  const selectedProgram = programs.find((item) => item.id === programId);
  const labels: Record<Mode, string> = {
    login: "Sign in",
    college: "Create student account",
    outsider: "Create outsider account",
    verify: "Verify email",
    forgot: "Send reset code",
    reset: "Set new password",
  };
  return (
    <Screen bottomGap={28}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 6 }}>
        <Logo size={38} />
        <View style={{ gap: 1 }}>
          <Text
            style={{
              fontFamily: fonts.display,
              fontSize: 21,
              fontWeight: "600",
              color: colors.ink,
              letterSpacing: -0.5,
            }}
          >
            CampusOps
          </Text>
          <Text
            style={{
              fontFamily: fonts.mono,
              fontSize: 8.5,
              letterSpacing: 1.4,
              textTransform: "uppercase",
              color: colors.muted,
            }}
          >
            Student events
          </Text>
        </View>
      </View>
      <Title
        eyebrow={mode === "login" ? "Welcome back" : registering ? "New account" : "Account access"}
        title={
          mode === "login"
            ? "Your campus, in your pocket."
            : registering
              ? "Join your next event."
              : "Account access"
        }
        subtitle="Events, passes and event help, without the queue."
      />
      <Card>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Chip label="Sign in" selected={mode === "login"} onPress={() => go("login")} />
          <Chip
            label="College student"
            selected={mode === "college"}
            onPress={() => go("college")}
          />
          <Chip
            label="Outside student"
            selected={mode === "outsider"}
            onPress={() => go("outsider")}
          />
        </View>
        <Note message={error} />
        <Note message={notice} tone="neutral" />
        {mode !== "verify" && (
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            placeholder="you@college.edu"
            testID="email"
          />
        )}
        {registering && (
          <>
            <Field
              label="Full name"
              value={fullName}
              onChangeText={setFullName}
              autoCapitalize="sentences"
            />
            <Field
              label="Phone number"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              placeholder="+91 98765 43210"
              hint="Used by event coordinators if they need to reach you on the day."
              testID="phone"
            />
            {mode === "outsider" && (
              <Field
                label="Institution"
                value={institutionName}
                onChangeText={setInstitutionName}
                autoCapitalize="sentences"
              />
            )}
          </>
        )}
        {mode === "college" && (
          <>
            <Field
              label="College ID number"
              value={rollNumber}
              onChangeText={setRollNumber}
              placeholder="As printed on your college ID"
            />
            <View style={{ gap: 8 }}>
              <Text style={{ fontWeight: "600" }}>Programme</Text>
              {programs.length === 0 ? (
                <Text style={{ color: "#6b7085" }}>
                  Programmes have not been added yet. Please contact your administrator.
                </Text>
              ) : (
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  {programs.map((item) => (
                    <Chip
                      key={item.id}
                      label={
                        item.departmentName ? `${item.name} · ${item.departmentName}` : item.name
                      }
                      selected={programId === item.id}
                      onPress={() => {
                        setProgramId(item.id);
                        setStudyYear("");
                      }}
                    />
                  ))}
                </View>
              )}
            </View>
            {selectedProgram && (
              <>
                <View style={{ gap: 8 }}>
                  <Text style={{ fontWeight: "600" }}>Year of study</Text>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {Array.from({ length: selectedProgram.durationYears }, (_, i) => i + 1).map(
                      (year) => (
                        <Chip
                          key={year}
                          label={`Year ${year}`}
                          selected={studyYear === String(year)}
                          onPress={() => setStudyYear(String(year))}
                        />
                      ),
                    )}
                  </View>
                  {selectedProgram.foundationYears > 0 && studyYear && (
                    <Text style={{ color: "#6b7085" }}>
                      First {selectedProgram.foundationYears} year
                      {selectedProgram.foundationYears === 1 ? "" : "s"} are shared across
                      programmes; your department membership updates automatically after that.
                    </Text>
                  )}
                </View>
                {!selectedProgram.departmentId && !selectedProgram.foundationDepartmentId && (
                  <>
                    <Text style={{ fontWeight: "600" }}>Department</Text>
                    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                      {departments.map((d) => (
                        <Chip
                          key={d.id}
                          label={d.name}
                          selected={departmentId === d.id}
                          onPress={() => setDepartmentId(d.id)}
                        />
                      ))}
                    </View>
                  </>
                )}
              </>
            )}
            <Field
              label="Graduation year"
              value={graduationYear}
              onChangeText={setGraduationYear}
              keyboardType="numeric"
              maxLength={4}
              placeholder={String(new Date().getFullYear() + 4)}
            />
          </>
        )}
        {(mode === "verify" || mode === "reset") && (
          <>
            {config?.exposeDemoOtp && challenge?.demoOtp && (
              <Note
                tone="warn"
                message={`Demo email mode · code ${challenge.demoOtp}. No email was sent.`}
              />
            )}
            <Field
              label="6-digit code"
              value={otp}
              onChangeText={setOtp}
              keyboardType="numeric"
              maxLength={6}
            />
          </>
        )}
        {mode !== "forgot" && mode !== "verify" && (
          <Field
            label={mode === "reset" || registering ? "New password" : "Password"}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            hint={registering || mode === "reset" ? "At least 10 characters." : undefined}
            testID="password"
          />
        )}
        {mode !== "forgot" && mode !== "verify" && (
          <Button
            label={showPassword ? "Hide password" : "Show password"}
            variant="ghost"
            onPress={() => setShowPassword((value) => !value)}
          />
        )}
        <Button
          label={labels[mode]}
          onPress={() => void submit()}
          busy={busy}
          testID="auth-submit"
        />
        {mode === "login" && (
          <Button label="Forgot password?" variant="ghost" onPress={() => go("forgot")} />
        )}
        {(mode === "forgot" || mode === "reset" || mode === "verify") && (
          <Button label="Back to sign in" variant="ghost" onPress={() => go("login")} />
        )}
        {registering && (
          <Note
            tone="neutral"
            message={
              mode === "college"
                ? "After email verification, a faculty member verifies your college ID. You cannot edit a verified profile yourself."
                : "Outside students need email verification only. You will see public events and events you are invited to."
            }
          />
        )}
      </Card>
      <Text
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          color: colors.muted,
          textAlign: "center",
          paddingTop: 6,
        }}
      >
        CampusOps · Made by Vineet
      </Text>
    </Screen>
  );
}
