import type { RawPostInput } from "../src/lib/types";

export const SAMPLE_POSTS: RawPostInput[] = [
  {
    url: "https://example.org/jobs/ml",
    published: "2026-11-17",
    title: "Software Engineer, Model Evaluation",
    text: "We're hiring an engineer to build evaluation tools for language models. Apply by email to hiring@example.org.",
    date_kind: "published",
    content_kind: "full",
  },
  {
    url: "https://example.org/jobs/vision",
    published: "2026-11-17",
    title: "Computer Vision Engineer",
    text: "Join our research team to evaluate visual recognition models. Apply through our careers page at https://example.org/careers/vision.",
    date_kind: "published",
    content_kind: "full",
  },
  {
    url: "https://example.org/jobs/sales",
    published: "2026-11-17",
    title: "Sales Executive",
    text: "Our AI company is hiring for enterprise sales. Email sales@example.org.",
    date_kind: "published",
    content_kind: "full",
  },
];
