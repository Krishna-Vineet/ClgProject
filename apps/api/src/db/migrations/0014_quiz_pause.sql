-- A quiz can be paused, not only opened and closed for good.
--
-- The old model had two one-way doors: publishing was only allowed from DRAFT,
-- and closing was final. A coordinator who closed a quiz by mistake could not
-- reopen it, and neither button respected the open/close window that was typed
-- into the form. PAUSED is the middle state that was missing: inside the window,
-- a coordinator may stop *new* starts as many times as they like and resume
-- again, while attempts already running continue to their own deadline.
ALTER TYPE quiz_status ADD VALUE IF NOT EXISTS 'PAUSED';
