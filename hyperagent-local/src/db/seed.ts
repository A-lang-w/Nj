import { fileURLToPath } from "node:url";
import { sql, eq } from "drizzle-orm";
import { db } from "./connection.js";
import { users, agents, memories } from "./schema.js";
import { ensurePersonalWorkspace } from "../services/workspace-service.js";
import { DEFAULT_MODEL } from "../config/constants.js";
import { logger } from "../lib/logger.js";

async function seedUser(): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      email: "local@hyperagent.local",
      displayName: "Local User",
    })
    .onConflictDoNothing()
    .returning();
  if (user) return user.id;
  // Conflict path: the row already exists (possibly with any id after
  // user-row churn), so resolve it by email. A hardcoded fallback would
  // seed a stranger's workspace — or violate FKs if that id is gone.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "local@hyperagent.local"))
    .limit(1);
  if (!existing)
    throw new Error("[Seed] local user missing after upsert conflict");
  return existing.id;
}

async function seedWorkspace(userId: number): Promise<number> {
  // Same find-or-create rule as login: one owner, no divergent copies.
  const result = await ensurePersonalWorkspace(userId);
  if (!result.ok)
    throw new Error(`[Seed] workspace ensure failed: ${result.error.message}`);
  return result.value.id;
}

async function seedAgents(workspaceId: number): Promise<void> {
  // Idempotent: agents has no unique key for onConflictDoNothing to catch,
  // so a second run would duplicate the roster. Skip when seeded already.
  const [existing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  if ((existing?.count ?? 0) > 0) return;
  await db
    .insert(agents)
    .values([
      {
        workspaceId,
        name: "General Assistant",
        description: "A helpful general-purpose AI assistant.",
        systemPrompt: "You are a helpful assistant. Be concise and accurate.",
        model: DEFAULT_MODEL,
      },
      {
        workspaceId,
        name: "Code Expert",
        description: "Specialized in software engineering tasks.",
        systemPrompt:
          "You are an expert software engineer. Write clean, well-documented code. Explain your reasoning.",
        model: DEFAULT_MODEL,
      },
    ])
    .onConflictDoNothing();
}

async function seedMemories(workspaceId: number): Promise<void> {
  // Seed memories matching original product content for local demo parity.
  // mode: 'json' columns stringify on write; pass values, not text.
  // Idempotent: never wipe — a re-run must preserve user-created memories.
  const [existing] = await db
    .select({ count: sql<number>`count(*)` })
    .from(memories)
    .where(eq(memories.workspaceId, workspaceId));
  if ((existing?.count ?? 0) > 0) return;
  await db.insert(memories).values([
    {
      workspaceId,
      agentId: null,
      content:
        "Nick's Tutte model version lifecycle has six stages: Ideation (on Muse/Brio) → Pre-training (data and config prep on Muse, then the job is pushed to z.ai) → Training (on z.ai) → Post-training (evals and safety probes on Muse, Claude, or similar tools) → Beta (served as tutte-<ver>-beta with looping benchmarks) → Live (locked; serving and monitoring only). Each stage has a gate. Beta → Live requires a stable benchmark loop and Nick's explicit approval. Without Nick's explicit approval, agents must not make a serving swap, declare a version final, or put a new version live. 0.0.0 is the permanent locked baseline.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "When expanding or restructuring Nick's agent teams, never delete, replace, or recreate existing saved agents. New roles are added alongside the current roster, and existing agents are reassigned under department heads rather than rebuilt.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "On 1867labs.ca, the hero badge wording 'TUTTE 0.0.1 — API LIVE' is Nick's own standing call. Agents must not change or remove it unless Nick explicitly says so. They may point out inconsistencies with other page copy, but the decision stays with him.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick has locked the direction for Tutte 0.0.2. It is trained from scratch; he rejected Qwen or any open-weight foundation. Open training data is fine. The plan is to train the largest Frontier model first, then distill to Standard and Mini. Every training source is tagged into a removable provenance pot: Preferred (Canada first, then UK, then EU/rest of West), USA, and Tainted (China, Russia, etc.). Tainted sources are reviewed carefully, not banned. Non-commercial (NC) licences are excluded from commercial training, and CanLII is not bulk-scraped. Agents should not relitigate these decisions.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick has a standing persist-first rule for Tutte and other heavy project artifacts. Important large outputs, such as model weights, packed data, and checkpoints, must be moved into persistent storage with checksums verified as soon as each stage completes. They should be bundled in at least two reset-surviving locations. Temporary folders (/tmp), gitignored files, and hardlinks never count as safe storage.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick wants each startup's agent team structured as a hierarchical org chart. A CEO agent sits at the top, with the Chief of Staff and Executive Assistant directly under it. Below that is a department-head agent for each department (e.g., Marketing Head), and the specialist agents report to their department head (e.g., Content Marketing and SEO under Marketing Head). His full blueprint is 38 specialists across 11 departments. Executive/HQ: Chief of Staff, Executive Assistant. Marketing: Content, SEO, Social, Paid Ads, Email, Brand & Creative, Market Research, Events & Webinar, PR & Comms. Sales: SDR/Outbound, AE/Closer, Sales Ops/CRM Hygiene, Proposal & RFP, Competitive Intel. Operations: SOP & Docs, Process Automation, Vendor & Tool Mgmt, QA & Compliance. Implementation/Onboarding: Onboarding Coordinator, Technical Implementation, Training & Enablement, Migration. Tech/Engineering: Backend, Frontend, DevOps/Infra, QA/Test Automation, Security & Privacy, AI/Integration. Customer Success: Support Triage, Knowledge Base, Health Score & Churn, Renewal & Expansion. Product: Product Manager, User Research. Finance: Bookkeeping & Invoicing, FP&A. People/HR: Recruiting, People Ops. Data & Analytics: Analytics, Reporting. The Chief of Staff triages all agent outputs and produces a daily brief. Nick wants a department head in place for every department except People & HR, so work can be routed to heads. Specialist roles are still added incrementally, only when a role has real work. He does not want every workflow set up in advance and rewritten later.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick wants work routed through the org chart rather than done by Arthur (Chief of Staff) directly. Arthur hands a task to the relevant department head, such as the Tech & Engineering head for website, GitHub or hosting work. The head delegates pieces to its specialists and stays accountable for the task being complete, tested and implemented. Any follow-up work is delegated down again. The aim is parallel progress, so Nick isn't waiting on Arthur to finish hands-on work himself.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick (Nick Taylor on the site but that is not his actual surname, which is aisbitt) is the founder of 1867 Labs (1867labs.ca), a Toronto-based Canadian AI lab that trains 'Tutte', a family of small, efficient AI models named after codebreaker W. T. Tutte. Public-facing copy always uses 'Nick Taylor' and must never include 'Aisbitt'. The project's earlier brand was 'Vega', which is now retired; old files and paths may still say Vega. Its core positioning is Canadian-owned, sovereign AI: Canadian-hosted inference, a free tier, an '1867 API', and sovereign deployment. It also brands itself on radical transparency, publishing an 'honest ledger' of its benchmark results, including weak ones.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "The 1867 Labs website is static HTML served from Hostinger (public_html). Nick does not want the live website changed; he was not happy with earlier redesign ideas, so agents should not propose or prepare copy/design edits unless he asks. GitHub repo nickaisbitt/1867 holds a read-only snapshot of the live site on branch setup/hostinger-static-site-2026-10-11 (draft PR #1, unmerged); main is untouched. Hostinger stays production; GitHub is version control only. Tutte model code, weights, and API live separately in a C.ai/MUSE environment. Never put .env files, API keys, or secrets in the repo. Any live production change or deployment requires Nick's explicit approval.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick wants a polished HTML org chart of his 1867 Labs agent team that stays current as the team grows. Whenever agents are added, renamed, or restructured, the existing org-chart webpage should be updated and republished in place, not replaced with a new one. Saved agents appear in color with their claymation avatars. Planned blueprint roles that have not been built yet appear as grey placeholder tiles. When a role is built, its tile turns from grey to colored.",
      tagsJson: [],
    },
    {
      workspaceId,
      agentId: null,
      content:
        "Nick wants his agents to have very simple, first-name-only human names (e.g., Maya, Leo, Ava) that suit the role, and a consistent claymation visual style for agent avatars and icons.",
      tagsJson: [],
    },
  ]);
}

export async function seed() {
  logger.info("[Seed] Seeding default data...");

  const userId = await seedUser();
  const workspaceId = await seedWorkspace(userId);
  await seedAgents(workspaceId);
  await seedMemories(workspaceId);

  logger.info("[Seed] Done.");
}

// Only auto-run as a CLI (`npm run db:seed`); importing this module from
// tests must not seed as a side effect.
const isMain =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  seed().catch((err) => {
    logger.error("[Seed] Failed", { error: err });
    process.exit(1);
  });
}
