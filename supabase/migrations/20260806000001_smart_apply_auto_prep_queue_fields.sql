-- Smart Apply Auto Prep (docs/Smart Apply Auto Prep Blueprint.md §12). Extends
-- the existing smart_apply_queue table -- no new parallel table. The original
-- blueprint's separate "auto_apply_decisions" concept is not built;
-- smart_apply_queue already is the record of what got prepared and how.

alter table smart_apply_queue
  add column if not exists generation_source text not null default 'manual',
  add column if not exists generation_result text;

-- 'manual' | 'automatic'. The Cost Boundary (automation_preferences /
-- checkAndConsumeAutomationBudget) only ever applies to 'automatic' rows --
-- manual generation is completely unaffected by Auto Prep's budget.
comment on column smart_apply_queue.generation_source is 'manual | automatic';

-- Reserved now, populated by nothing in V1: null | accepted | edited | discarded.
-- Exists purely so a future feedback-loop phase can be added without a
-- migration, per the locked blueprint decision.
comment on column smart_apply_queue.generation_result is 'null | accepted | edited | discarded -- reserved for future use, unpopulated in V1';
