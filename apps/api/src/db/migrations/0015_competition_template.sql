-- Competitions (hackathons' cousins: quizzes, contests, trials) are their own
-- template. They were being filed as WORKSHOP or CUSTOM, which made the event
-- list lie about what was happening.
ALTER TYPE event_template ADD VALUE IF NOT EXISTS 'COMPETITION';
