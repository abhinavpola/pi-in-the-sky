import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

type BundledSkill = {
  readonly name: string;
  readonly description: string;
  readonly content: string;
};

const BUNDLED_SKILLS: readonly BundledSkill[] = [
  {
    name: "flight-planning",
    description:
      "Recall travel preferences, inspect past trip receipts, research current fares, and confirm with the user before booking.",
    content: [
      "# Flight & Trip Planning",
      "1. Read standing preferences via memory_get_profile (home airport, airline, seating, hotel preferences).",
      "2. Search prior trip receipts or confirmations with gmail_search and gmail_get_message.",
      "3. Check schedule conflicts using calendar_list_events.",
      "4. Research current fares and itineraries via browser_navigate and browser_snapshot.",
      "5. Present exact itinerary, carrier, dates, and total price, and ask the user in chat before any checkout or payment.",
      "6. Save new travel preferences or trip notes with memory_set_profile or memory_write_note.",
    ].join("\n"),
  },
  {
    name: "inbox-triage",
    description:
      "Search Gmail threads, summarize urgent items, and prepare draft replies without sending unconfirmed emails.",
    content: [
      "# Inbox Triage",
      "1. Query relevant messages with gmail_search.",
      "2. Fetch full thread details with gmail_get_message for actionable items.",
      "3. Group findings by urgent action required, waiting on others, and informational.",
      "4. Use gmail_create_draft for replies; ask the user in chat before sending any external communication.",
    ].join("\n"),
  },
  {
    name: "browser-automation",
    description:
      "Navigate pages, refresh snapshots after each action, fill forms carefully, and hand off sign-in or MFA via Live View.",
    content: [
      "# Browser Automation",
      "1. Open target URL with browser_navigate.",
      "2. Inspect the current DOM/text state with browser_snapshot before clicking or typing.",
      "3. After each browser_click or browser_fill that triggers navigation, capture a fresh browser_snapshot.",
      "4. If login, CAPTCHA, or MFA blocks progress, call browser_request_takeover so the user can complete sign-in in Live View.",
      "5. Ask the user in chat before submitting payment, checkout, or irreversible form actions.",
    ].join("\n"),
  },
  {
    name: "forms-and-reservations",
    description:
      "Fill registration or dining reservation forms using profile facts and confirm details before final submission.",
    content: [
      "# Forms & Reservations",
      "1. Load user contact, dietary, and scheduling preferences with memory_get_profile and calendar_list_events.",
      "2. Open the reservation or registration form with browser_navigate and inspect fields with browser_snapshot.",
      "3. Populate fields using browser_fill and verify all values with a fresh browser_snapshot.",
      "4. Ask the user in chat with the complete summary before clicking the final submit or confirm button.",
    ].join("\n"),
  },
];

const LoadSkillSchema = obj({
  name: str(),
});

export function createSkillsExtension(
  skills: readonly BundledSkill[] = BUNDLED_SKILLS,
): Extension {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  const loadSkillTool: ToolRegistration<typeof LoadSkillSchema> = {
    name: "load_skill",
    description:
      "Load the full step-by-step playbook for one of the available bundled skills.",
    parameters: LoadSkillSchema,
    replay: "safe",
    async execute({ name }) {
      const skill = byName.get(name);
      if (!skill) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: `Unknown skill "${name}". Available: ${skills.map((s) => s.name).join(", ")}`,
            },
          ],
        };
      }
      return {
        output: [{ type: "text", text: skill.content }],
      };
    },
  };

  return {
    name: "skills",
    sections: [
      {
        key: "available_skills",
        render: () =>
          [
            "Available skills (call load_skill with the skill name when relevant):",
            ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
          ].join("\n"),
      },
    ],
    tools: [loadSkillTool],
  };
}
