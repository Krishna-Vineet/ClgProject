import {
  ADMISSION_MODE_LABELS,
  APPROVAL_TIER_LABELS,
  APPROVAL_TYPE_LABELS,
  EVENT_AUDIENCE_LABELS,
  EVENT_TEMPLATE_LABELS,
} from "@campusops/shared";
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { EventReportSnapshot } from "./service";

/**
 * Server-side PDF rendering with pdf-lib (pure JS, no headless browser, works on
 * Bun and on small hosts). Built-in Helvetica is used deliberately: embedding a
 * Unicode font would add megabytes to the deployment for no benefit here.
 * Non-Latin characters are transliterated to '?' by winansi, so the attendee
 * table also carries email and roll number, which are always ASCII.
 */

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 42;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.85, 0.87, 0.9);
const BRAND = rgb(0.31, 0.27, 0.9);

class Writer {
  private page: PDFPage;
  private y: number;
  constructor(
    private doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private footerText: string,
  ) {
    this.page = doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  private ensure(space: number) {
    if (this.y - space < MARGIN + 28) this.newPage();
  }

  private safe(text: string): string {
    // Standard fonts are winansi. Fold typographic punctuation to ASCII first so
    // real names and sentences never turn into a row of question marks; only
    // genuinely unsupported scripts fall back to '?'.
    return text
      .replace(/[\u2013\u2014\u2212]/g, "-")
      .replace(/[\u2018\u2019\u201B]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/[\u2022\u00B7]/g, "-")
      .replace(/[\u2192\u2190]/g, "->")
      .replace(/\u00A0/g, " ")
      .replace(/[^\x20-\x7E\u00A1-\u00FF]/g, "?");
  }

  title(text: string) {
    this.ensure(40);
    this.page.drawText(this.safe(text), {
      x: MARGIN,
      y: this.y - 20,
      size: 19,
      font: this.bold,
      color: INK,
    });
    this.y -= 30;
  }

  subtitle(text: string) {
    this.ensure(20);
    this.page.drawText(this.safe(text), {
      x: MARGIN,
      y: this.y - 11,
      size: 9.5,
      font: this.regular,
      color: MUTED,
    });
    this.y -= 20;
  }

  section(text: string) {
    this.ensure(34);
    this.y -= 10;
    this.page.drawText(this.safe(text.toUpperCase()), {
      x: MARGIN,
      y: this.y - 10,
      size: 9,
      font: this.bold,
      color: BRAND,
    });
    this.y -= 16;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.7,
      color: LINE,
    });
    this.y -= 12;
  }

  /** Wrapped paragraph. */
  paragraph(text: string, size = 9.5) {
    const words = this.safe(text).split(/\s+/);
    let line = "";
    const maxW = PAGE_W - MARGIN * 2;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.regular.widthOfTextAtSize(candidate, size) > maxW && line) {
        this.ensure(size + 4);
        this.page.drawText(line, {
          x: MARGIN,
          y: this.y - size,
          size,
          font: this.regular,
          color: INK,
        });
        this.y -= size + 4;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      this.ensure(size + 4);
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y - size,
        size,
        font: this.regular,
        color: INK,
      });
      this.y -= size + 4;
    }
    this.y -= 3;
  }

  kv(label: string, value: string) {
    this.ensure(15);
    this.page.drawText(this.safe(label), {
      x: MARGIN,
      y: this.y - 9,
      size: 9,
      font: this.bold,
      color: MUTED,
    });
    const labelW = 132;
    const text = this.safe(value);
    const maxW = PAGE_W - MARGIN * 2 - labelW;
    let shown = text;
    while (this.regular.widthOfTextAtSize(shown, 9.5) > maxW && shown.length > 4)
      shown = `${shown.slice(0, -4)}...`;
    this.page.drawText(shown, {
      x: MARGIN + labelW,
      y: this.y - 9,
      size: 9.5,
      font: this.regular,
      color: INK,
    });
    this.y -= 15;
  }

  table(headers: string[], widths: number[], rows: string[][], emptyText: string) {
    if (rows.length === 0) {
      this.paragraph(emptyText);
      return;
    }
    const drawHeader = () => {
      this.ensure(24);
      let x = MARGIN;
      headers.forEach((h, i) => {
        this.page.drawText(this.safe(h), {
          x,
          y: this.y - 9,
          size: 8,
          font: this.bold,
          color: MUTED,
        });
        x += widths[i] ?? 80;
      });
      this.y -= 14;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: PAGE_W - MARGIN, y: this.y },
        thickness: 0.5,
        color: LINE,
      });
      this.y -= 6;
    };
    drawHeader();
    for (const row of rows) {
      if (this.y - 14 < MARGIN + 28) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN;
      row.forEach((cell, i) => {
        const w = (widths[i] ?? 80) - 6;
        let text = this.safe(cell ?? "");
        while (this.regular.widthOfTextAtSize(text, 8.5) > w && text.length > 3)
          text = `${text.slice(0, -4)}...`;
        this.page.drawText(text, {
          x,
          y: this.y - 8,
          size: 8.5,
          font: this.regular,
          color: INK,
        });
        x += widths[i] ?? 80;
      });
      this.y -= 13;
    }
    this.y -= 6;
  }

  finish() {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawLine({
        start: { x: MARGIN, y: MARGIN + 16 },
        end: { x: PAGE_W - MARGIN, y: MARGIN + 16 },
        thickness: 0.5,
        color: LINE,
      });
      p.drawText(this.safe(this.footerText), {
        x: MARGIN,
        y: MARGIN + 4,
        size: 7,
        font: this.regular,
        color: MUTED,
      });
      const label = `Page ${i + 1} of ${pages.length}`;
      p.drawText(label, {
        x: PAGE_W - MARGIN - this.regular.widthOfTextAtSize(label, 7),
        y: MARGIN + 4,
        size: 7,
        font: this.regular,
        color: MUTED,
      });
    });
  }
}

export async function renderReportPdf(s: EventReportSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`Event Report - ${s.event.title}`);
  doc.setSubject(`CampusOps event report for ${s.event.title}`);
  doc.setCreator("CampusOps");
  doc.setProducer("CampusOps");

  const fmt = (value: string | null) => {
    if (!value) return "-";
    try {
      return new Date(value).toLocaleString("en-IN", {
        timeZone: s.institution.timezone,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return value;
    }
  };

  const w = new Writer(doc, regular, bold, `Checksum ${s.integrity.checksum.slice(0, 32)}...`);

  w.title("Event Report");
  w.subtitle(
    `${s.club.name}${s.club.department ? ` · ${s.club.department}` : ""} · generated ${fmt(s.generatedAt)} (${s.institution.timezone})`,
  );

  w.section("Event");
  w.kv("Title", s.event.title);
  w.kv(
    "Type",
    EVENT_TEMPLATE_LABELS[s.event.template as keyof typeof EVENT_TEMPLATE_LABELS] ??
      s.event.template,
  );
  w.kv("Status at generation", s.event.status);
  w.kv("Date and time", `${fmt(s.event.startsAt)} to ${fmt(s.event.endsAt)}`);
  w.kv("Venue", s.event.venueSummary ?? (s.event.onlineMeetingUrl ? "Online" : "Not recorded"));
  if (s.event.onlineMeetingUrl) w.kv("Meeting link", s.event.onlineMeetingUrl);
  w.kv(
    "Audience",
    EVENT_AUDIENCE_LABELS[s.event.audience as keyof typeof EVENT_AUDIENCE_LABELS] ??
      s.event.audience,
  );
  w.kv(
    "Admission",
    ADMISSION_MODE_LABELS[s.event.admissionMode as keyof typeof ADMISSION_MODE_LABELS] ??
      s.event.admissionMode,
  );
  w.kv("Capacity", String(s.event.capacity));
  w.kv("Event revision", String(s.event.revision));
  w.kv("Published", fmt(s.event.publishedAt));
  w.kv("Completed", fmt(s.event.completedAt));
  if (s.event.cancelledAt) {
    w.kv("Cancelled", fmt(s.event.cancelledAt));
    w.kv("Cancellation reason", s.event.cancellationReason ?? "-");
  }

  w.section("Description");
  w.paragraph(s.event.description?.trim() || "No description was recorded for this event.");
  if (s.event.jobDescription) {
    w.section("Job description");
    w.paragraph(s.event.jobDescription);
  }

  w.section("Organised by");
  w.table(
    ["Name", "Role", "Email"],
    [170, 110, 231],
    s.organizers.map((o) => [
      o.fullName,
      o.clubRole === "LEAD" ? "Club lead" : "Coordinator",
      o.email,
    ]),
    "No active club members were recorded.",
  );
  if (s.clubFaculty?.length)
    w.kv("Club faculty", s.clubFaculty.map((f) => `${f.fullName} (${f.email})`).join("; "));
  else if (s.facultyAdvisor)
    // Older filed reports named a single advisor; keep rendering them faithfully.
    w.kv("Faculty advisor", `${s.facultyAdvisor.fullName} (${s.facultyAdvisor.email})`);

  w.section("Permissions and approvals");
  w.paragraph(
    "Each permission below was decided separately. Escalations are shown in the order they happened.",
  );
  for (const a of s.approvals) {
    w.kv(
      APPROVAL_TYPE_LABELS[a.type as keyof typeof APPROVAL_TYPE_LABELS] ?? a.type,
      `${a.title} — ${a.finalStatus}${a.isRequired ? " (required)" : " (optional)"}`,
    );
    if (a.decidedBy) w.kv("  Decided by", `${a.decidedBy.fullName} on ${fmt(a.decidedAt)}`);
    for (const t of a.trail) {
      const tiers = [t.fromTier, t.toTier]
        .filter(Boolean)
        .map((x) => APPROVAL_TIER_LABELS[x as keyof typeof APPROVAL_TIER_LABELS] ?? x)
        .join(" -> ");
      w.paragraph(
        `    ${t.action} by ${t.actor}${tiers ? ` (${tiers})` : ""} at ${fmt(t.at)}${t.comment ? ` — "${t.comment}"` : ""}`,
        8.5,
      );
    }
    w.paragraph("", 4);
  }
  if (s.approvals.length === 0) w.paragraph("No approval requests were recorded for this event.");

  w.section("Faculty involved");
  w.table(
    ["Name", "Involvement", "Email"],
    [140, 190, 181],
    s.facultyInvolved.map((f) => [f.fullName, f.role, f.email]),
    "No faculty involvement was recorded.",
  );

  w.section("Resources used");
  w.table(
    ["Resource", "Unit", "From", "To", "Status"],
    [130, 105, 108, 108, 60],
    s.resourcesUsed.map((r) => [r.resource, r.unit, fmt(r.startsAt), fmt(r.endsAt), r.status]),
    "No resources were booked for this event.",
  );

  w.section("Attendance summary");
  const at = s.attendance;
  w.kv("Registered", String(at.registered));
  w.kv("Confirmed", String(at.confirmed));
  w.kv("Waitlisted", String(at.waitlisted));
  w.kv("Cancelled / rejected", `${at.cancelled} / ${at.rejected}`);
  w.kv("Capacity", String(at.capacity));
  if (at.fillRatePercent !== null) w.kv("Fill rate", `${at.fillRatePercent}% of capacity`);
  if (at.source === "QR_SCAN") {
    w.kv("Checked in (QR)", String(at.checkedIn));
    if (at.attendanceRatePercent !== null)
      w.kv("Attendance rate", `${at.attendanceRatePercent}% of confirmed`);
  } else {
    w.paragraph(
      "Check-in was not recorded with QR scanning for this event, so attendance below reflects confirmed registrations only. No claim is made about physical presence.",
      8.5,
    );
  }

  // ── Phase 7: what happened on the day ──────────────────────────────────
  if (s.access) {
    w.section("Access counters");
    if (s.access.counters.length === 0) {
      w.paragraph("No access QRs were configured for this event.", 8.5);
    } else {
      w.table(
        ["Counter", "Type", "Granted", "Denied", "Unique", "Offline", "ID mismatch"],
        [148, 74, 52, 48, 48, 52, 89],
        s.access.counters.map((c) => [
          c.name,
          c.qrType + (c.maxUses ? ` x${c.maxUses}` : ""),
          String(c.granted),
          String(c.denied),
          String(c.uniqueParticipants),
          String(c.offlineSynced),
          String(c.identityMismatches),
        ]),
        "No counters.",
      );
      w.kv("Total granted / denied", `${s.access.totalGranted} / ${s.access.totalDenied}`);
      w.kv(
        "Identity checks",
        `${s.access.identityChecks.match} matched · ${s.access.identityChecks.mismatch} mismatched · ${s.access.identityChecks.notRequired} not required`,
      );
      if (s.access.offlineSynced > 0)
        w.paragraph(
          `${s.access.offlineSynced} scan(s) were captured without network and synced afterwards. Each was validated against the moment it was captured, and each code could still only be used once.`,
          8.5,
        );
      if (s.access.denialReasons.length > 0) {
        w.section("Refused scans by reason");
        w.table(
          ["Reason", "Count"],
          [400, 111],
          s.access.denialReasons.map((d) => [d.reason, String(d.count)]),
          "None.",
        );
      }
    }
  }

  if (s.quiz) {
    w.section("Quiz seat allocation");
    w.kv("Mode", s.quiz.mode === "TOP_N" ? "Top scores get seats" : "First to qualify until full");
    w.kv("Status", s.quiz.status);
    w.kv("Questions / seats", `${s.quiz.questionCount} / ${s.quiz.seats}`);
    if (s.quiz.passScore !== null) w.kv("Pass mark", `${s.quiz.passScore}%`);
    w.kv(
      "Attempts",
      `${s.quiz.attempts} started · ${s.quiz.submitted} submitted · ${s.quiz.expired} expired`,
    );
    w.kv("Qualified", String(s.quiz.qualified));
    if (s.quiz.averagePercent !== null)
      w.kv("Score", `average ${s.quiz.averagePercent}% · highest ${s.quiz.highestPercent ?? 0}%`);
    w.kv("Seats from quiz", `${s.quiz.confirmed} confirmed · ${s.quiz.waitlisted} waitlisted`);
    w.kv("Allocated at", s.quiz.allocatedAt ? fmt(s.quiz.allocatedAt) : "Not yet allocated");
  }

  if (s.issues) {
    w.section("Participant issues");
    w.kv("Raised", String(s.issues.total));
    w.kv("Resolved / still open", `${s.issues.resolved} / ${s.issues.open}`);
    if (s.issues.byCategory.length > 0)
      w.table(
        ["Category", "Count"],
        [400, 111],
        s.issues.byCategory.map((c) => [c.category, String(c.count)]),
        "None.",
      );
    if (s.issues.byLocation.length > 0)
      w.table(
        ["Location", "Count"],
        [400, 111],
        s.issues.byLocation.map((c) => [c.location, String(c.count)]),
        "None.",
      );
  }

  if (s.announcements && s.announcements.length > 0) {
    w.section("Announcements");
    w.table(
      ["Title", "Audience", "Published", "Withdrawn"],
      [220, 110, 120, 61],
      s.announcements.map((a) => [
        a.title,
        a.audience === "REGISTERED" ? "Registered" : "All who can see",
        fmt(a.publishedAt),
        a.revoked ? "Yes" : "No",
      ]),
      "None.",
    );
  }

  w.section("Attendee list");
  if (s.attendeesTruncated) {
    w.paragraph(
      `Showing the first ${s.attendees.length} of ${s.attendance.registered} registrations. The summary figures above are exact and cover every registration; only this list is capped.`,
      8.5,
    );
  }
  w.table(
    ["#", "Name", "Roll no.", "Dept", "Status", "Check-in"],
    [22, 126, 80, 58, 78, 147],
    s.attendees.map((a, i) => [
      String(i + 1),
      a.fullName,
      a.rollNumber ?? "-",
      a.departmentCode ?? a.department ?? (a.accountType === "OUTSIDER_STUDENT" ? "Outsider" : "-"),
      a.registrationStatus,
      a.checkedInAt ? fmt(a.checkedInAt) : "-",
    ]),
    "No registrations were recorded for this event.",
  );

  if (s.notes) {
    w.section("Coordinator notes");
    w.paragraph(s.notes);
  }

  w.section("Record integrity");
  w.kv("Generated by", `${s.generatedBy.fullName} (${s.generatedBy.email})`);
  w.kv("Generated at", fmt(s.generatedAt));
  w.kv("Algorithm", "SHA-256 of the canonical report snapshot");
  w.paragraph(s.integrity.checksum, 8);
  w.paragraph(
    "This report is an immutable record. Regenerating a report creates a new numbered version rather than altering this one.",
    8,
  );

  w.finish();
  return doc.save();
}
