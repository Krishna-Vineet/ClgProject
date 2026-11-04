import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Loading,
  Muted,
  Note,
  Row,
  Screen,
  Title,
  colors,
} from "../components/ui";
import { type Page, api, errorMessage } from "../lib/api";
import { complaintLocationId } from "../lib/format";
import {
  type QueuedScan,
  type SyncSummary,
  clearSettled,
  enqueue,
  flushQueue,
  newScanId,
  readQueue,
} from "../lib/offlineScans";
import { useSession } from "../lib/session";
import type { Checkpoint, ManagedEvent, ScanInspection, ScanOutcome } from "../lib/types";

const REFUSALS: Record<string, string> = {
  QR_REPLAYED: "This code was already used. Do not let them in again on it.",
  QR_EXPIRED: "This code has expired. Ask them to refresh their pass.",
  QR_INVALID: "This code could not be verified.",
  WRONG_CHECKPOINT: "This code belongs to a different QR.",
  CHECKPOINT_REVOKED: "This QR has been withdrawn by the coordinator.",
  QR_SWITCHED_OFF: "This QR is switched off right now.",
  CHECKPOINT_DISABLED: "This QR is switched off right now.",
  LIMIT_REACHED: "This participant has used up this QR.",
  IDENTITY_MISMATCH: "The ID did not match. Do not let them in.",
  NOT_CONFIRMED: "This participant does not hold a confirmed place.",
  PASS_REVOKED: "This participant's pass has been revoked.",
  EVENT_NOT_LIVE: "The event is not live. Start the event from the web console before scanning.",
  OUTSIDE_WINDOW: "This QR is not valid at this time.",
  NOT_TODAY: "This QR is set for a different campus day. Check the QR's date before scanning.",
  SCAN_TOO_OLD: "This scan is too old to record. Scan the participant again.",
  FORBIDDEN: "You cannot scan for this event.",
};

function refusalMessage(reason: string): string {
  return REFUSALS[reason] ?? "Entry was refused. Ask the coordinator to check this participant.";
}

export function ScannerScreen({ onComplaint }: { onComplaint: (id: string) => void }) {
  const { me, config } = useSession();
  // Scanning belongs to the event's club team. Admins and HOD/Dean oversee
  // events but do not scan; the API would refuse them anyway.
  const organiser = Boolean(me?.clubMemberships.length);
  const [mode, setMode] = useState<"complaint" | "access">("complaint");
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<ManagedEvent[]>([]);
  const [eventId, setEventId] = useState("");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointId, setCheckpointId] = useState("");
  const [inspection, setInspection] = useState<ScanInspection | null>(null);
  const [token, setToken] = useState("");
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const lock = useRef(false);
  const [queue, setQueue] = useState<QueuedScan[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const checkpoint = checkpoints.find((c) => c.id === checkpointId);

  useEffect(() => {
    if (mode !== "access") return;
    api<Page<ManagedEvent>>("/me/events?limit=100")
      .then((p) => setEvents(p.items.filter((e) => e.status === "LIVE")))
      .catch((e) => setError(errorMessage(e)));
  }, [mode]);
  useEffect(() => {
    setCheckpoints([]);
    setCheckpointId("");
    setInspection(null);
    setOutcome(null);
    if (!eventId) return;
    api<{ items: Checkpoint[] }>(`/events/${eventId}/checkpoints`)
      .then((p) => setCheckpoints(p.items))
      .catch((e) => setError(errorMessage(e)));
  }, [eventId]);

  const handle = useCallback(
    async (raw: string) => {
      if (lock.current) return;
      const value = raw.trim();
      if (!value) return;
      lock.current = true;
      setBusy(true);
      setError(null);
      setOutcome(null);
      try {
        const locationId = complaintLocationId(value, config?.complaintQrBase ?? "");
        if (locationId) {
          onComplaint(locationId);
          return;
        }
        if (mode === "complaint")
          throw new Error(
            "That is not an event complaint QR. Scan the poster at your event location.",
          );
        if (!checkpointId) throw new Error("Choose the QR you are scanning for first.");
        setToken(value);
        setInspection(await api<ScanInspection>("/access/inspect", { token: value, checkpointId }));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
        setTimeout(() => {
          lock.current = false;
        }, 1200);
      }
    },
    [mode, checkpointId, config?.complaintQrBase, onComplaint],
  );

  const refreshQueue = useCallback(async () => {
    setQueue(await readQueue());
  }, []);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  /**
   * Queue-first: the scan is written to disk before any network call, so losing
   * signal (or closing the app) cannot lose a person who has already walked in.
   * When the network is available we sync immediately and show the real verdict.
   */
  async function commit(identityCheck: "MATCH" | "MISMATCH" | "NOT_REQUIRED") {
    setBusy(true);
    setError(null);
    setSyncNote(null);
    const clientScanId = newScanId();
    const capturedAt = new Date().toISOString();
    try {
      await enqueue({
        clientScanId,
        checkpointId,
        token,
        identityCheck,
        capturedAt,
        label: inspection?.participant.fullName ?? "Participant",
      });
      await refreshQueue();
      setInspection(null);
      setToken("");

      const summary = await flushQueue();
      await refreshQueue();
      const mine = (await readQueue()).find((q) => q.clientScanId === clientScanId);
      if (summary.offline || mine?.state === "pending") {
        setSyncNote(
          "Saved on this phone. It will be recorded when you are back online — keep scanning.",
        );
      } else if (mine?.state === "synced") {
        setOutcome({
          result: "GRANTED",
          reason: "OK",
          message: `${mine.label} may enter.`,
          checkpoint: {
            id: checkpointId,
            name: checkpoint?.name ?? "",
            qrType: checkpoint?.qrType ?? "",
          },
          participant: inspection?.participant ?? null,
          useNumber: mine.useNumber ?? null,
          remainingAfter: mine.remainingAfter ?? null,
          direction: mine.direction ?? null,
        });
      } else if (mine) {
        setOutcome({
          result: "DENIED",
          reason: mine.reason ?? "REFUSED",
          message: refusalMessage(mine.reason ?? ""),
          checkpoint: {
            id: checkpointId,
            name: checkpoint?.name ?? "",
            qrType: checkpoint?.qrType ?? "",
          },
          participant: inspection?.participant ?? null,
          useNumber: null,
          remainingAfter: null,
          direction: null,
        });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const summary: SyncSummary = await flushQueue();
      await refreshQueue();
      setSyncNote(
        summary.offline
          ? "Still offline. Everything is saved on this phone."
          : `${summary.accepted} recorded, ${summary.refused} refused, ${summary.remaining} still waiting.`,
      );
    } finally {
      setSyncing(false);
    }
  }
  function reset() {
    setInspection(null);
    setOutcome(null);
    setToken("");
    setManual("");
    setError(null);
    lock.current = false;
  }

  return (
    <Screen>
      <Title
        eyebrow="Camera"
        title="Scan a QR"
        subtitle={
          mode === "complaint"
            ? "Scan a location poster to report an issue to this event's organisers."
            : "Choose your event QR, scan the participant, then check their college ID."
        }
      />
      {organiser && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip
            label="Report an issue"
            selected={mode === "complaint"}
            onPress={() => {
              setMode("complaint");
              reset();
            }}
          />
          <Chip
            label="Check a participant"
            selected={mode === "access"}
            onPress={() => {
              setMode("access");
              reset();
            }}
          />
        </View>
      )}
      <Note message={error} />
      {mode === "access" && (
        <Card title="Scanning station">
          <Muted>
            Only this event's coordinators and club faculty can scan. Your normal login is used.
          </Muted>
          {events.length === 0 ? (
            <Empty
              title="No live event to scan"
              detail="Access QRs only work while an event is live. Ask its coordinator to start it from the web console, or check that you are on the event's club team."
            />
          ) : (
            <View style={{ gap: 8 }}>
              <Muted>Event</Muted>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {events.map((e) => (
                  <Chip
                    key={e.id}
                    label={e.title}
                    selected={eventId === e.id}
                    onPress={() => setEventId(e.id)}
                  />
                ))}
              </View>
            </View>
          )}
          {checkpoints.length > 0 && (
            <>
              <Muted>QR being served</Muted>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {checkpoints.map((c) => (
                  <Chip
                    key={c.id}
                    label={`${c.name}${c.isActive ? "" : " (off)"}`}
                    selected={checkpointId === c.id}
                    onPress={() => {
                      setCheckpointId(c.id);
                      setInspection(null);
                      setOutcome(null);
                    }}
                  />
                ))}
              </View>
            </>
          )}
        </Card>
      )}
      {mode === "access" && queue.some((q) => q.state === "pending") && (
        <Card
          title={`${queue.filter((q) => q.state === "pending").length} scan(s) waiting to sync`}
        >
          <Muted>
            These are saved on this phone and are not on the server yet. They will be recorded
            automatically when you reconnect. Do not clear them before then.
          </Muted>
          <View style={{ gap: 6, marginTop: 8 }}>
            {queue
              .filter((q) => q.state === "pending")
              .slice(-5)
              .map((q) => (
                <View
                  key={q.clientScanId}
                  style={{ flexDirection: "row", justifyContent: "space-between" }}
                >
                  <Text style={{ color: colors.ink, flex: 1 }}>{q.label}</Text>
                  <Badge label="waiting" tone="warn" />
                </View>
              ))}
          </View>
          <Button
            label="Sync now"
            variant="ghost"
            busy={syncing}
            onPress={syncNow}
            testID="sync-queue"
          />
        </Card>
      )}
      {syncNote ? <Note message={syncNote} tone="neutral" /> : null}
      {mode === "access" && queue.some((q) => q.state === "refused") && (
        <Card title="Refused on sync">
          <Muted>
            These scans reached the server but were not accepted. Each reason is from the server,
            not a guess.
          </Muted>
          <View style={{ gap: 6, marginTop: 8 }}>
            {queue
              .filter((q) => q.state === "refused")
              .slice(-5)
              .map((q) => (
                <View key={q.clientScanId}>
                  <Text style={{ color: colors.ink }}>{q.label}</Text>
                  <Muted>{refusalMessage(q.reason ?? "")}</Muted>
                </View>
              ))}
          </View>
          <Button
            label="Clear reviewed refusals"
            variant="ghost"
            onPress={() => {
              void clearSettled().then(refreshQueue);
            }}
          />
        </Card>
      )}
      {outcome ? (
        <Card title={outcome.result === "GRANTED" ? "Access granted" : "Access denied"}>
          <Badge
            label={
              outcome.direction
                ? outcome.direction === "IN"
                  ? "Entry recorded"
                  : "Exit recorded"
                : outcome.result === "GRANTED"
                  ? "Granted"
                  : "Denied"
            }
            tone={outcome.result === "GRANTED" ? "good" : "bad"}
          />
          <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "700" }}>
            {outcome.message}
          </Text>
          {outcome.participant && <Row label="Participant" value={outcome.participant.fullName} />}
          {outcome.remainingAfter !== null && <Muted>{outcome.remainingAfter} uses left</Muted>}
          <Button label="Scan next person" onPress={reset} />
        </Card>
      ) : inspection ? (
        <Card title="Confirm the person in front of you">
          <Row label="Pass holder" value={inspection.participant.fullName} />
          <Row label="Email" value={inspection.participant.email} />
          <Row label="QR" value={inspection.checkpoint.name} />
          {inspection.standing.nextDirection && (
            <Badge
              label={`This scan records ${inspection.standing.nextDirection === "IN" ? "entry" : "exit"}`}
              tone="primary"
            />
          )}
          {!inspection.standing.availableNow && (
            <Note tone="warn" message={inspection.standing.unavailableReason} />
          )}
          {inspection.checkpoint.requiresIdCheck ? (
            <>
              <Note
                tone="neutral"
                message="Compare the physical college ID and the person with this pass. Do not confirm on someone else's behalf."
              />
              <Button
                label="ID matches — record scan"
                onPress={() => void commit("MATCH")}
                busy={busy}
              />
              <Button
                label="ID does not match — refuse"
                variant="danger"
                onPress={() => void commit("MISMATCH")}
                disabled={busy}
              />
            </>
          ) : (
            <Button
              label="Record scan (no ID check required)"
              onPress={() => void commit("NOT_REQUIRED")}
              busy={busy}
            />
          )}
          <Button label="Cancel" variant="ghost" onPress={reset} disabled={busy} />
        </Card>
      ) : (
        <>
          <Card>
            {!permission ? (
              <Loading label="Checking camera permission…" />
            ) : permission.granted ? (
              <View
                style={{
                  height: 300,
                  borderRadius: 14,
                  overflow: "hidden",
                  backgroundColor: "#111827",
                }}
              >
                <CameraView
                  style={{ flex: 1 }}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => void handle(data)}
                />
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 50,
                    left: 40,
                    right: 40,
                    bottom: 50,
                    borderWidth: 2,
                    borderColor: "white",
                    borderRadius: 20,
                  }}
                />
              </View>
            ) : (
              <Empty
                title="Camera access is off"
                detail="Allow camera access to scan a poster or pass. You can also paste a code below."
              />
            )}
            {!permission?.granted && (
              <Button label="Allow camera" onPress={() => void requestPermission()} />
            )}
            {busy && <Loading label="Reading code…" />}
          </Card>
          <Card title="Or paste a code">
            <Field
              label="QR contents"
              value={manual}
              onChangeText={setManual}
              multiline
              maxLength={2000}
              hint="Useful when the camera cannot read a damaged poster."
            />
            <Button
              label="Read code"
              variant="ghost"
              onPress={() => void handle(manual)}
              disabled={busy || !manual.trim()}
            />
          </Card>
        </>
      )}
    </Screen>
  );
}
