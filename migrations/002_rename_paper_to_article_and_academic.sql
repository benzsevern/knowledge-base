-- Rename the catch-all `paper` type into two explicit types:
--   - article         : scraped web content (had meta.kind='article')
--   - academic_paper  : arxiv PDFs and other formal research (everything else)
--
-- The distinction already existed via meta.kind; this promotes it to a
-- first-class column value so counters, filters, and downstream tools can
-- speak the same language.

UPDATE entities
   SET type = 'article'
 WHERE type = 'paper'
   AND meta->>'kind' = 'article';

UPDATE entities
   SET type = 'academic_paper'
 WHERE type = 'paper';
