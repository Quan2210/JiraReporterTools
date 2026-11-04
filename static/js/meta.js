import { getJson } from "./api.js";

export const meta = {
  jiraBaseUrl: "",
  maxRows: 5000,
  projects: [],
  fields: [],
  fieldById: {},
  statuses: [],
  statusCategories: {},
  issueTypes: [],
  groupsAvailable: true,
};

export async function loadHealth() {
  const me = await getJson("/api/health");
  meta.jiraBaseUrl = me.jira_base_url;
  meta.maxRows = me.max_rows;
  return me;
}

export async function loadMeta() {
  const [projects, fields, statuses, types] = await Promise.all([
    getJson("/api/meta/projects"), getJson("/api/meta/fields"),
    getJson("/api/meta/statuses"), getJson("/api/meta/issuetypes"),
  ]);
  meta.projects = projects;
  meta.fields = fields;
  meta.fieldById = Object.fromEntries(fields.map((f) => [f.id, f]));
  meta.statuses = statuses;
  meta.statusCategories = Object.fromEntries(statuses.map((s) => [s.name, s.category]));
  meta.issueTypes = types;
}
