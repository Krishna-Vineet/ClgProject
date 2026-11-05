import { ACCOUNT_TYPE_LABELS, GLOBAL_ROLE_LABELS, type GlobalRole } from "@campusops/shared/ui";
import * as DocumentPicker from "expo-document-picker";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Field,
  Muted,
  Note,
  Row,
  Screen,
  Title,
  colors,
  fonts,
} from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { registerForPush } from "../lib/push";
import { useSession } from "../lib/session";
import type { Challenge } from "../lib/types";

export function ProfileScreen({ onComplaints }: { onComplaints: () => void }) {
  const { me, config, signOut, reloadMe } = useSession();
  // Whose installation this is. The product used to sign itself "Made by Vineet"
  // on every screen; a student opening the app should see their college.
  const institution = config?.institutionName ?? "your institution";
  const [changing, setChanging] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [phone, setPhone] = useState(me?.user.phone ?? "");
  const [phoneBusy, setPhoneBusy] = useState(false);

  useEffect(() => {
    setPhone(me?.user.phone ?? "");
  }, [me?.user.phone]);

  if (!me) return null;
  const student = me.studentProfile;
  async function changePassword() {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/change-password", { currentPassword, newPassword });
      await signOut();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  async function savePhone() {
    setPhoneBusy(true);
    setError(null);
    setNotice(null);
    try {
      const trimmed = phone.trim();
      await api("/me", { phone: trimmed.length > 0 ? trimmed : null }, { method: "PATCH" });
      await reloadMe();
      setNotice("Phone number saved. Coordinators will use it if they need to reach you.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPhoneBusy(false);
    }
  }

  async function enablePush() {
    setPushBusy(true);
    setPushNote(null);
    try {
      const result = await registerForPush();
      setPushNote(result.detail);
    } finally {
      setPushBusy(false);
    }
  }

  async function uploadIdProof() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      const file = picked.assets[0];
      if (!file) throw new Error("Choose an image or PDF of your student ID proof.");
      if (!config || config.storageMode !== "s3")
        throw new Error(
          "Secure file storage is not configured yet. Ask your administrator to enable storage.",
        );
      const mimeType = file.mimeType ?? "application/octet-stream";
      const signed = await api<{
        fileId: string;
        uploadUrl: string;
        headers: Record<string, string>;
      }>("/files/presign", { purpose: "COLLEGE_ID_PROOF", mimeType, sizeBytes: file.size ?? 0 });
      const blob = await (await fetch(file.uri)).blob();
      const uploaded = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: signed.headers,
        body: blob,
      });
      if (!uploaded.ok) throw new Error(`Upload failed (${uploaded.status}). Try again.`);
      await api(`/files/${signed.fileId}/complete`, {});
      await reloadMe();
      setNotice("Student ID proof uploaded securely. Faculty can now review it.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function logout(all = false) {
    setBusy(true);
    setError(null);
    try {
      if (all) {
        await api("/auth/logout-all", {});
      }
      await signOut();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Screen>
      <Title eyebrow="Your account" title={me.user.fullName} subtitle={me.user.email} />
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Badge label={ACCOUNT_TYPE_LABELS[me.user.accountType]} tone="primary" />
        <Badge
          label={
            me.user.status === "ACTIVE"
              ? "Verified & active"
              : me.user.status.replace(/_/g, " ").toLowerCase()
          }
          tone={me.user.status === "ACTIVE" ? "good" : "warn"}
        />
      </View>
      <Note message={error} />
      <Note message={notice} tone="good" />
      <Card title="Contact details">
        <Muted>
          A working phone number lets coordinators reach you about waitlists and venue changes. Your
          college email stays fixed.
        </Muted>
        <Field
          label="Phone number"
          value={phone}
          onChangeText={setPhone}
          placeholder="+91 98765 43210"
          keyboardType="phone-pad"
          maxLength={20}
          hint="Indian mobile numbers, with or without +91."
        />
        <Button
          label={phoneBusy ? "Saving…" : "Save phone number"}
          onPress={() => void savePhone()}
          busy={phoneBusy}
          disabled={phoneBusy || phone.trim() === (me.user.phone ?? "")}
        />
      </Card>
      {student && (
        <Card title="Student profile">
          <Row label="Institution" value={student.institutionName} />
          <Row label="Roll number" value={student.rollNumber ?? "—"} />
          <Row
            label="Student ID proof"
            value={student.idProofFileId ? "Uploaded for faculty review" : "Not uploaded"}
          />
          {!student.idProofFileId && (
            <Button
              label="Upload student ID proof"
              variant="ghost"
              onPress={() => void uploadIdProof()}
              busy={busy}
              disabled={config?.storageMode !== "s3"}
            />
          )}
          {config?.storageMode !== "s3" && (
            <Muted>
              Secure uploads are unavailable until the administrator configures private object
              storage.
            </Muted>
          )}
          <Row label="Program" value={student.program ?? "—"} />
          <Row
            label="Graduation year"
            value={student.graduationYear ? String(student.graduationYear) : "—"}
          />
          <Muted>
            Only faculty can verify or update your student profile. If something is wrong, contact
            your faculty coordinator.
          </Muted>
        </Card>
      )}
      {me.globalRoles.length > 0 && (
        <Card title="Institution roles">
          {me.globalRoles.map((r, i) => (
            <Badge
              key={`${r.role}-${i}`}
              label={GLOBAL_ROLE_LABELS[r.role as GlobalRole] ?? r.role}
            />
          ))}
        </Card>
      )}
      {me.clubMemberships.length > 0 && (
        <Card title="Club team">
          {me.clubMemberships.map((m) => (
            <Row
              key={m.clubId}
              label={m.clubName}
              value={
                m.clubRole === "LEAD"
                  ? "Club lead"
                  : m.clubRole === "FACULTY"
                    ? "Club faculty"
                    : "Coordinator"
              }
            />
          ))}
          <Muted>
            Use Scan to check participants at your events. Approvals and event setup stay on the
            management website.
          </Muted>
        </Card>
      )}
      <Card title="Notifications">
        <Muted>
          Get told about venue changes and seat decisions for your events. Announcements always
          appear under Updates, even with notifications off.
        </Muted>
        <Button
          label="Enable notifications on this phone"
          variant="ghost"
          busy={pushBusy}
          onPress={() => void enablePush()}
          testID="enable-push"
        />
        {pushNote && <Note message={pushNote} tone="neutral" />}
      </Card>
      <Card title="Account & security">
        <Button label="My reported issues" variant="ghost" onPress={onComplaints} />
        <Button
          label={changing ? "Cancel password change" : "Change password"}
          variant="ghost"
          onPress={() => {
            setChanging(!changing);
            setError(null);
          }}
        />
        {changing && (
          <>
            <Field
              label="Current password"
              value={currentPassword}
              onChangeText={setCurrentPassword}
              secureTextEntry
            />
            <Field
              label="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              secureTextEntry
              hint="At least 10 characters. Changing it signs you out everywhere."
            />
            <Button
              label="Update password"
              onPress={() => void changePassword()}
              busy={busy}
              disabled={!currentPassword || newPassword.length < 10}
            />
          </>
        )}
        <Button
          label="Refresh profile"
          variant="ghost"
          onPress={() => {
            setNotice(null);
            void reloadMe()
              .then(() => setNotice("Profile refreshed."))
              .catch((e) => setError(errorMessage(e)));
          }}
        />
        <Button label="Sign out" variant="ghost" onPress={() => void logout()} disabled={busy} />
        <Button
          label="Sign out of all devices"
          variant="danger"
          onPress={() => void logout(true)}
          disabled={busy}
        />
      </Card>
      <Card title={`About CampusOps at ${institution}`}>
        <Muted>
          The student side of the campus event desk: register, carry your pass, get told when
          something changes, and raise an issue without walking to the office.
        </Muted>
        <Row label="Version" value="2.0" />
        <Row
          label="File storage"
          value={config?.storageMode === "s3" ? "private, encrypted" : "not configured"}
        />
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 12,
            borderTopWidth: 1,
            borderTopColor: colors.line,
            paddingTop: 12,
            marginTop: 2,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.mono,
              fontSize: 9,
              letterSpacing: 1.3,
              textTransform: "uppercase",
              color: colors.muted,
            }}
          >
            Institution
          </Text>
          <Text
            style={{
              fontFamily: fonts.display,
              fontSize: 22,
              fontWeight: "500",
              color: colors.ink,
              letterSpacing: -0.3,
            }}
          >
            {institution}
          </Text>
        </View>
      </Card>
      <Text
        style={{
          fontFamily: fonts.mono,
          fontSize: 9,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          color: colors.muted,
          textAlign: "center",
          paddingTop: 4,
        }}
      >
        CampusOps · student events · {new Date().getFullYear()}
      </Text>
    </Screen>
  );
}

export function PendingScreen() {
  const { me, signOut, reloadMe, config } = useSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [phone, setPhone] = useState(me?.user.phone ?? "");
  const [phoneBusy, setPhoneBusy] = useState(false);

  useEffect(() => {
    setPhone(me?.user.phone ?? "");
  }, [me?.user.phone]);

  if (!me) return null;
  async function resend() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ verification?: Challenge }>("/auth/resend-verification", {
        email: me?.user.email,
      });
      setChallenge(result.verification ?? null);
      setNotice(
        result.verification?.delivery === "DEMO"
          ? `Demo email mode: use the code ${result.verification.demoOtp}.`
          : "A new code has been sent to your email.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await api("/auth/verify-email", { challengeId: challenge.challengeId, otp: otp.trim() });
      await reloadMe();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function uploadIdProof() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      const file = picked.assets[0];
      if (!file) throw new Error("Choose an image or PDF of your student ID proof.");
      if (config?.storageMode !== "s3")
        throw new Error(
          "Secure file storage is not configured yet. Ask your administrator to enable storage.",
        );
      const mimeType = file.mimeType ?? "application/octet-stream";
      const signed = await api<{
        fileId: string;
        uploadUrl: string;
        headers: Record<string, string>;
      }>("/files/presign", { purpose: "COLLEGE_ID_PROOF", mimeType, sizeBytes: file.size ?? 0 });
      const blob = await (await fetch(file.uri)).blob();
      const uploaded = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: signed.headers,
        body: blob,
      });
      if (!uploaded.ok) throw new Error(`Upload failed (${uploaded.status}). Try again.`);
      await api(`/files/${signed.fileId}/complete`, {});
      await reloadMe();
      setNotice("Student ID proof uploaded securely. Faculty can now review it.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen bottomGap={28}>
      <Title
        eyebrow="One more step"
        title={
          me.user.status === "PENDING_EMAIL"
            ? "Verify your email"
            : me.user.status === "PENDING_VERIFICATION"
              ? "Faculty verification pending"
              : "Account unavailable"
        }
        subtitle={me.user.email}
      />
      <Card>
        <Note
          tone="warn"
          message={
            me.user.status === "PENDING_VERIFICATION"
              ? "Your email is verified. A faculty member must verify your college ID before you can register for events. You cannot approve this yourself."
              : me.user.status === "PENDING_EMAIL"
                ? "Enter the code from your email. College students then wait for faculty verification."
                : "Contact your institution about this account."
          }
        />
        <Note message={error} />
        <Note message={notice} tone="good" />
        {me.user.status === "PENDING_VERIFICATION" && me.studentProfile && (
          <>
            <Note
              tone={me.studentProfile.idProofFileId ? "good" : "warn"}
              message={
                me.studentProfile.idProofFileId
                  ? "Student ID proof uploaded. Faculty can review your document."
                  : "No ID proof is on file. Upload a clear image or PDF so faculty can verify your account."
              }
            />
            <Button
              label={
                me.studentProfile.idProofFileId ? "Replace ID proof" : "Upload student ID proof"
              }
              variant="ghost"
              onPress={() => void uploadIdProof()}
              busy={busy}
              disabled={config?.storageMode !== "s3"}
            />
            {config?.storageMode !== "s3" && (
              <Muted>
                Secure document uploads are unavailable until the administrator configures private
                storage.
              </Muted>
            )}
          </>
        )}
        {me.user.status === "PENDING_EMAIL" && (
          <>
            {config?.exposeDemoOtp && challenge?.demoOtp && (
              <Note
                tone="warn"
                message={`Demo email mode · code ${challenge.demoOtp}. No email was sent.`}
              />
            )}
            {challenge && (
              <>
                <Field
                  label="6-digit code"
                  value={otp}
                  onChangeText={setOtp}
                  keyboardType="numeric"
                  maxLength={6}
                />
                <Button
                  label="Verify email"
                  onPress={() => void verify()}
                  busy={busy}
                  disabled={otp.trim().length !== 6}
                />
              </>
            )}
            <Button
              label={challenge ? "Resend code" : "Send verification code"}
              variant="ghost"
              onPress={() => void resend()}
              busy={busy}
            />
          </>
        )}
        <Button label="Sign out" variant="ghost" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}
