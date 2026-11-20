# CampusOps Figure Generation Prompts

These prompts are intended to generate **11 separate report illustrations**. Generate each as its own landscape image; never combine multiple figures into one image. The diagrams should be presentation-ready, legible when printed on an A4 report page, and visually consistent as a set.

## Shared visual direction

Append these directions to every prompt:

> Create one clean, precise, professional academic project-report figure for a real campus operations software platform. Landscape 16:9 composition, white or very pale cool-grey background, restrained navy/blue/teal palette with a small amount of amber for decisions and muted red only for denied/cancelled states. Flat vector infographic, simple rounded rectangles, consistent stroke widths, generous whitespace, aligned grid, clear arrowheads. Use large, high-contrast sans-serif typography: title large; labels at least 24 px at 1600×900; supporting text at least 20 px. Keep every text item fully inside its shape with generous padding. Wrap long labels onto multiple lines. Ensure arrows do not cross text or unrelated boxes. No overlap, clipping, tiny text, decorative clutter, gradients, perspective, or 3D. Use only the exact short wording specified below; do not invent labels, misspell words, or add extra text. Keep the full composition inside the canvas with safe margins. Output one standalone image, 16:9 landscape.

**Important:** If the image model struggles to render exact labels, keep each label short as provided and add the typography accurately in an editing/layout tool afterward. Do not reduce the font size to force a long phrase to fit.

---

## Figure 1 — CampusOps problem context and stakeholder flow

> Draw a stakeholder-flow infographic titled **“CampusOps: Problem Context & Stakeholders”**. On the left, show a muted-red group titled **“Disconnected coordination”** with four short labels: **Paper forms**, **Spreadsheets**, **Email**, **Messaging groups**. In the center, show a prominent blue platform box titled **“CampusOps”**, with three benefits: **One shared workflow**, **Role-scoped records**, **Traceable decisions**. On the right, arrange four separate stakeholder cards vertically: **Participants** — “Discover and register”; **Event teams** — “Plan and operate”; **Faculty and leaders** — “Review and approve”; **Administration** — “Configure and oversee”. Draw one clear arrow from disconnected coordination into CampusOps and four clear arrows from CampusOps to the four stakeholder groups. Use balanced spacing; no arrows over text.

## Figure 2 — CampusOps event lifecycle

> Draw a left-to-right process diagram titled **“CampusOps Event Lifecycle”**. Use seven evenly spaced state cards connected by clear arrows: **DRAFT** — “Plan event”; **SUBMITTED** — “Request review”; **PENDING APPROVALS** — “Review permissions”; **READY** — “Approvals and reservations complete”; **PUBLISHED** — “Visible to participants”; **LIVE** — “Operate and verify”; **COMPLETED** — “Close and report”. Below the central states, place a separate muted-red **CANCELLED** card, with a dashed branch from the lifecycle labelled **“Permitted cancellation”**. Add a short footer note: **“Critical revisions may require renewed review.”** Do not imply that every event must have placement scheduling or security-officer approval. Keep connector lines between cards, not through text.

## Figure 3 — Layered system architecture

> Draw a system architecture titled **“CampusOps System Architecture”**. At the top, place two client boxes side by side: **Management Web** with sublabel “React · Vite · TypeScript”; **Mobile App** with sublabel “Expo · React Native · TypeScript”. Both clients must point independently to a central **CampusOps API** box with sublabel “Bun · Hono · validation · authorization”. Below the API, show three supporting components in one row: **PostgreSQL** — “Drizzle ORM”; **Private Object Storage** — “Optional S3-compatible”; **Transactional Email** — “Optional provider”. Connect the API to each supporting component. Clearly show request direction from both clients to the API and from the API to its supporting services. Do not draw the clients as a chain, and do not suggest that the web client calls the mobile app.

## Figure 4 — Context-level data flow diagram

> Draw a context-level DFD titled **“CampusOps Context Diagram”**. Put one central process, a large circle or rounded rectangle labelled **“0 — CampusOps Platform”**. Around it place four external entities: **Participant**, **Event Team**, **Faculty and Leaders**, and **Administrator**. Use labelled arrows in both directions. Participant to system: “Account · browse · registration · complaint”; system to participant: “Event details · status · pass”. Event Team to system: “Event · approvals · resources · operations”; system to event team: “Decisions · bookings · reports”. Faculty and Leaders to system: “Verification · approval decisions”; system to them: “Scoped queues · event status”. Administrator to system: “User and institution configuration”; system to administrator: “Operational records”. Keep the system process central and the four actors outside it. Make arrow labels large and place them in clear whitespace, not over lines or boxes.

## Figure 5 — Level 1 data flow diagram

> Draw a Level 1 DFD titled **“CampusOps Level 1 Data Flow”**. Use six numbered process boxes in a clear two-row snake layout with directional arrows: **1 Identity and Access** — “Users · roles · scope”; **2 Event and Club Operations** — “Events · revisions”; **3 Approvals and Resources** — “Decisions · reservations”; **4 Participation and Access** — “Registration · QR scans”; **5 Complaints** — “Intake · handling trail”; **6 Reports and Audit** — “Immutable event record”. Layout: processes 1, 2, 3 left-to-right across the first row; process 4 at the right of the second row; then 5 and 6 continue right-to-left. Connect the numbered processes in that order using arrows in the gutters between cards. At the bottom, add a wide data-store shape labelled **“Shared PostgreSQL Data Stores”** with smaller text **“Identity · events · approvals · resources · registrations · access · complaints · reports”**. Connect only the lower-row processes to this data-store row with short vertical arrows. Ensure the datastore does not overlap or collide with arrows. Avoid diagonal connectors crossing any boxes.

## Figure 6 — Simplified entity relationship diagram

> Draw a simplified ERD titled **“CampusOps Core Data Model”**. Use rectangular entity boxes with entity names in bold and only key attributes in smaller but still readable text. Entities: **USER** (“id · email · status”); **ROLE_ASSIGNMENT** (“user_id · role · scope”); **DEPARTMENT** (“id · name”); **CLUB** (“id · department_id”); **CLUB_MEMBERSHIP** (“club_id · user_id · role”); **EVENT** (“id · club_id · state”); **APPROVAL_REQUEST** (“event_id · approver · status”); **RESOURCE_RESERVATION** (“event_id · resource_unit · time”); **REGISTRATION** (“event_id · participant · status”); **PASS / CHECKPOINT / SCAN** (“participant · event · outcome”); **COMPLAINT / REPORT** (“event_id · location or snapshot”). Show relationships with elbow connectors that do not pass through entity boxes. Indicate cardinalities simply and consistently: a user has many role assignments; a department has many clubs; a club has many memberships and events; an event has many approval requests, reservations, registrations and reports; a registration can have a pass; a pass can have scan records; an event can have complaint records. Use a spacious three-row grid. Do not imply that the simplified diagram contains every database table.

## Figure 7 — Authentication and refresh-token flow

> Draw a sequence diagram titled **“CampusOps Authentication and Session Flow”** with four vertical lanes labelled **User**, **Web or Mobile Client**, **CampusOps API**, and **PostgreSQL**. Show the following numbered steps as clear horizontal arrows: 1. User submits email and password. 2. Client sends credentials to API. 3. API verifies the Argon2id password hash and account status using stored account data. 4. API returns a short-lived access token and establishes a refresh-token session. Add a note beside the client lane: **“Web: httpOnly cookie; Mobile: secure device storage.”** Then show: 5. Client requests refresh when needed. 6. API validates the hashed refresh token and rotates it. 7. Reuse of a rotated token revokes its token family. 8. Client sends access token to a protected API route; API checks identity, role and scope before returning data. Distinguish the access token from the refresh token. Keep sequence arrows horizontal and text clear of lane lines.

## Figure 8 — Approval and resource booking flow

> Draw a process diagram titled **“Approval and Resource Booking”**. Arrange five primary cards left-to-right: **Event Draft** — “Coordinator prepares event”; **Separate Requests** — “Each permission is tracked independently”; **Scoped Review** — “Authorised approver decides or escalates”; **Resource Reservation** — “Database prevents time conflicts”; **Publication Gate** — “Required approvals and reservations must be valid”. Connect these cards with arrows. Beneath the review card, add a muted-red exception card: **“Stale approval version”** — “Return conflict; do not overwrite”. Beneath resource reservation, add an amber exception card: **“Resource conflict”** — “Reject overlapping booking”. Use short branch arrows to these exception cards. Ensure arrows do not cover text and make the distinction between separate approval decisions and database-enforced booking conflicts obvious.

## Figure 9 — Event access QR verification flow

> Draw an event access verification sequence titled **“Event Access QR Verification”**. Show five main stages left-to-right: **Participant Pass** — “Short-lived signed QR”; **Authorised Scanner** — “Event operator scans”; **API Token Checks** — “Signature · expiry · one-time nonce”; **Access Rules** — “Pass · registration · checkpoint · usage limit”; **Recorded Result** — “Grant or deny · reason logged”. Connect stages with arrows. Below the access-rules stage, add a gold conditional box **“Identity check, if required”** — “Operator compares participant with ID”. Add a green security note near the API checks: **“Nonce is single-use; replay is refused.”** Show the conditional identity check as a branch, not a mandatory step for every checkpoint. Do not depict the QR itself as proof of identity.

## Figure 10 — Complaint QR and event issue-handling flow

> Draw a complaint workflow titled **“Event Complaint QR and Issue Handling”**. Show five steps left-to-right: **Coordinator Creates Location** — “Event-specific reporting point”; **Printable Complaint QR** — “Placed at event location”; **Participant Reports Issue** — “Valid event context required”; **Event Team Inbox** — “Visible to responsible organisers”; **Assigned and Resolved** — “Status and handling history”. Connect them with arrows. Add a prominent footer distinction: **“Complaint QR starts an issue report; it does not grant event access.”** Use a separate visual style or icon for complaint reporting so it cannot be confused with the event-entry pass. Keep the text large and avoid long paragraphs.

## Figure 11 — Sign-in screen of the management console

> Create a clean, realistic desktop sign-in screen mockup for the **CampusOps Management Console**, not a generic login page. Landscape 16:9 browser-window composition, light neutral background, no browser chrome. Place a small restrained CampusOps wordmark and subtitle **“Management Console”** on the left. On the right, show a centered white sign-in card with generous padding. Card text exactly: heading **“Welcome back.”**; description **“Sign in with the college email your institution has on record.”**; field label **“College email”** with placeholder **“you@institution.edu”**; field label **“Password”** with masked dots and a show/hide icon; link **“Forgot password?”**; primary button **“Sign in to the console”**. Under the button, show two separate small but readable notices: **“Staff accounts are created by an administrator.”** and **“Students should use the CampusOps mobile app.”** Use accessible contrast, clear field borders and a large primary action. Keep every line inside the card; wrap the description if needed. Do not add social sign-in, sign-up, sample credentials, people, photos, decorative illustrations, or extra controls.

---

## Export checklist

For every figure, check the generated output at full size before using it in the report:

- All requested labels are spelled correctly and fully visible.
- No text crosses a box border, arrow or other text.
- Supporting labels remain readable at normal A4 page width.
- Arrows communicate the intended direction and do not cross nodes.
- The figure is a single image, not a montage of multiple figures.
- Figure 11 is described as a **mockup** unless replaced with a genuine screenshot of the running application.
