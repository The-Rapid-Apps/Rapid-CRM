/**
 * Thin Postmark client. Fetch-based — no SDK dependency.
 *
 * Send a templated email, and manage templates. Errors are classified so a
 * caller knows whether to retry (429 / 5xx) or fail terminally (other 4xx).
 */
import { env } from "./env.server";

const POSTMARK_API = "https://api.postmarkapp.com";

export class PostmarkError extends Error {
  readonly status: number;
  /** Postmark's numeric ErrorCode, when the body carried one. */
  readonly errorCode?: number;
  /** Retryable = rate limit (429) or a Postmark 5xx; the worker backs off. */
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    errorCode: number | undefined,
    retryable: boolean,
  ) {
    super(message);
    this.name = "PostmarkError";
    this.status = status;
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

function requireToken(): string {
  const token = env.POSTMARK_SERVER_TOKEN;
  if (!token) {
    // Terminal, not retryable: a missing token won't fix itself on retry.
    throw new PostmarkError(
      "POSTMARK_SERVER_TOKEN is not configured",
      0,
      undefined,
      false,
    );
  }
  return token;
}

export type SendWithTemplateInput = {
  templateId?: number;
  templateAlias?: string;
  from: string;
  to: string;
  replyTo?: string;
  templateModel: Record<string, unknown>;
  messageStream?: string;
  /**
   * Per-message tracking overrides. Security mail sets both off: link
   * tracking rewrites every URL through Postmark's redirector, which would
   * route a one-time secret through a third party and into its click log.
   */
  trackLinks?: "None" | "HtmlAndText" | "HtmlOnly" | "TextOnly";
  trackOpens?: boolean;
};

export type SendWithTemplateResult = {
  messageId: string;
  to: string;
  submittedAt: string;
};

/** POST /email/withTemplate. Returns the Postmark MessageID on accept. */
export async function sendWithTemplate(
  input: SendWithTemplateInput,
): Promise<SendWithTemplateResult> {
  const token = requireToken();

  if (input.templateId == null && !input.templateAlias) {
    throw new PostmarkError(
      "send_email step needs a postmarkTemplateId or postmarkTemplateAlias",
      0,
      undefined,
      false,
    );
  }

  const body: Record<string, unknown> = {
    From: input.from,
    To: input.to,
    TemplateModel: input.templateModel,
    MessageStream: input.messageStream ?? env.POSTMARK_MESSAGE_STREAM,
  };
  if (input.replyTo) body.ReplyTo = input.replyTo;
  if (input.trackLinks) body.TrackLinks = input.trackLinks;
  if (input.trackOpens !== undefined) body.TrackOpens = input.trackOpens;
  if (input.templateId != null) body.TemplateId = input.templateId;
  else body.TemplateAlias = input.templateAlias;

  const response = await fetch(`${POSTMARK_API}/email/withTemplate`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    MessageID?: string;
    To?: string;
    SubmittedAt?: string;
    Message?: string;
    ErrorCode?: number;
  };

  // Postmark signals failure two ways, and BOTH must be checked: a non-2xx HTTP
  // status, OR a 2xx body whose `ErrorCode` is non-zero (their documented
  // contract — every response carries ErrorCode; 0 == OK). Checking only the
  // HTTP status lets a 200 with ErrorCode != 0 (e.g. inactive recipient) or a
  // body with no MessageID be recorded as "sent" while no email goes out.
  const errorCode = payload.ErrorCode ?? 0;
  if (!response.ok || errorCode !== 0 || !payload.MessageID) {
    // Retryable: HTTP rate-limit / Postmark 5xx, or the rate-limit ErrorCode.
    // Everything else (unverified sender, bad template, inactive recipient,
    // bad token) is terminal — it won't fix itself on retry.
    const retryable =
      response.status === 429 || response.status >= 500 || errorCode === 429;
    throw new PostmarkError(
      payload.Message ??
        `Postmark send failed (HTTP ${response.status}, ErrorCode ${errorCode})`,
      response.status,
      errorCode || undefined,
      retryable,
    );
  }

  return {
    messageId: payload.MessageID,
    to: payload.To ?? input.to,
    submittedAt: payload.SubmittedAt ?? "",
  };
}

export type BatchMessageInput = {
  templateId?: number;
  templateAlias?: string;
  from: string;
  to: string;
  replyTo?: string;
  templateModel: Record<string, unknown>;
  messageStream?: string;
};

/** One element of a batch response, aligned by index to the input messages. */
export type BatchResult = {
  to: string | null;
  messageId: string | null;
  errorCode: number;
  message: string | null;
};

/**
 * POST /email/batchWithTemplates — up to 500 messages in one request (spec §5).
 *
 * The batch endpoint returns HTTP 200 with a per-message result array; a
 * message can still have failed (ErrorCode != 0), so the caller records
 * per-recipient success/failure from `errorCode`. An HTTP-level failure (bad
 * token, 429, 5xx) throws PostmarkError so the whole chunk can be retried.
 */
export async function sendEmailBatchWithTemplates(
  messages: BatchMessageInput[],
): Promise<BatchResult[]> {
  const token = requireToken();
  if (messages.length === 0) return [];
  if (messages.length > 500) {
    throw new PostmarkError(
      "Postmark batch accepts at most 500 messages per request",
      0,
      undefined,
      false,
    );
  }

  const Messages = messages.map((m) => {
    const body: Record<string, unknown> = {
      From: m.from,
      To: m.to,
      TemplateModel: m.templateModel,
      MessageStream: m.messageStream ?? env.POSTMARK_MESSAGE_STREAM,
    };
    if (m.replyTo) body.ReplyTo = m.replyTo;
    if (m.templateId != null) body.TemplateId = m.templateId;
    else body.TemplateAlias = m.templateAlias;
    return body;
  });

  const response = await fetch(`${POSTMARK_API}/email/batchWithTemplates`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({ Messages }),
  });

  if (!response.ok) {
    const retryable =
      response.status === 429 || response.status >= 500;
    const errBody = (await response.json().catch(() => ({}))) as {
      Message?: string;
      ErrorCode?: number;
    };
    throw new PostmarkError(
      errBody.Message ?? `Postmark batch failed (HTTP ${response.status})`,
      response.status,
      errBody.ErrorCode,
      retryable,
    );
  }

  const payload = (await response.json().catch(() => [])) as Array<{
    To?: string;
    MessageID?: string;
    ErrorCode?: number;
    Message?: string;
  }>;
  return payload.map((r) => ({
    to: r.To ?? null,
    messageId: r.MessageID ?? null,
    errorCode: r.ErrorCode ?? 0,
    message: r.Message ?? null,
  }));
}

export type PostmarkSender = {
  email: string;
  name: string | null;
  confirmed: boolean;
};

export type PostmarkDomain = {
  name: string;
  dkimVerified: boolean;
  returnPathVerified: boolean;
};

/**
 * GET /domains — list account domains and their DKIM/Return-Path state.
 * Account-level: authenticated with the Postmark Account token, NOT the Server
 * token. Used to decide which sender signatures are sendable (see
 * listSenderSignatures). Cache at the call site.
 */
export async function listDomains(): Promise<PostmarkDomain[]> {
  const token = env.POSTMARK_ACCOUNT_TOKEN;
  if (!token) {
    throw new PostmarkError(
      "POSTMARK_ACCOUNT_TOKEN is not configured",
      0,
      undefined,
      false,
    );
  }
  const response = await fetch(`${POSTMARK_API}/domains?count=500&offset=0`, {
    headers: {
      Accept: "application/json",
      "X-Postmark-Account-Token": token,
    },
  });
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new PostmarkError(
      `Postmark domains list failed (HTTP ${response.status})`,
      response.status,
      undefined,
      retryable,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    Domains?: Array<{
      Name: string;
      DKIMVerified?: boolean;
      ReturnPathDomainVerified?: boolean;
    }>;
  };
  return (payload.Domains ?? []).map((d) => ({
    name: d.Name,
    dkimVerified: Boolean(d.DKIMVerified),
    returnPathVerified: Boolean(d.ReturnPathDomainVerified),
  }));
}

/**
 * GET /senders — list Sender Signatures (verified from-addresses) for the
 * editors' from-address dropdown. Account-level: authenticated with the
 * Postmark Account token, NOT the Server token. Cache at the call site.
 *
 * A signature is sendable — and so surfaced here — when it is individually
 * Confirmed, OR when it belongs to a DKIM-verified domain. Postmark leaves a
 * signature's `Confirmed` flag false until someone clicks its per-address
 * confirmation email, but any address under a DKIM-verified domain can send
 * without that step; filtering on `Confirmed` alone silently hid those.
 */
export async function listSenderSignatures(): Promise<PostmarkSender[]> {
  const token = env.POSTMARK_ACCOUNT_TOKEN;
  if (!token) {
    throw new PostmarkError(
      "POSTMARK_ACCOUNT_TOKEN is not configured",
      0,
      undefined,
      false,
    );
  }
  const [response, domains] = await Promise.all([
    fetch(`${POSTMARK_API}/senders?count=500&offset=0`, {
      headers: {
        Accept: "application/json",
        "X-Postmark-Account-Token": token,
      },
    }),
    // A domains failure shouldn't drop the confirmed senders that already
    // worked — degrade to "no DKIM-verified domains" instead.
    listDomains().catch(() => [] as PostmarkDomain[]),
  ]);
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new PostmarkError(
      `Postmark senders list failed (HTTP ${response.status})`,
      response.status,
      undefined,
      retryable,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    SenderSignatures?: Array<{
      Domain?: string | null;
      EmailAddress: string;
      Name: string | null;
      Confirmed: boolean;
    }>;
  };
  const dkimVerifiedDomains = new Set(
    domains.filter((d) => d.dkimVerified).map((d) => d.name.toLowerCase()),
  );
  return (payload.SenderSignatures ?? [])
    .filter((s) => {
      if (s.Confirmed) return true;
      const domain = (
        s.Domain ??
        s.EmailAddress.split("@")[1] ??
        ""
      ).toLowerCase();
      return domain ? dkimVerifiedDomains.has(domain) : false;
    })
    .map((s) => ({
      email: s.EmailAddress,
      name: s.Name,
      confirmed: s.Confirmed,
    }));
}

export type PostmarkTemplate = {
  templateId: number;
  alias: string | null;
  name: string;
};

export type PostmarkTemplateContent = {
  templateId: number;
  alias: string | null;
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  /**
   * Inbox preview text (a.k.a. preheader). Postmark has no dedicated field for
   * it, so the visual editor stores it as a hidden element at the top of the
   * HtmlBody; we recover it here so the campaign editor can preview it.
   */
  previewText: string;
};

/**
 * Invisible characters editors append to a preheader to stretch the inbox
 * snippet: zero-width spaces/joiners, soft hyphen (&shy;), combining grapheme
 * joiner (&#847;), figure space (&#8199;), word joiner, and the BOM. Stripped
 * so only the real preview text survives; &nbsp; is normalised to a plain
 * space and collapsed by the whitespace pass instead.
 */
const PREHEADER_PADDING = /[­͏​‌‍ ⁠﻿]/g;

/** Decode the handful of HTML entities that turn up in preheader text. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&shy;/gi, "­")
    .replace(/&zwnj;/gi, "‌")
    .replace(/&zwj;/gi, "‍")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&"); // last: avoid double-decoding e.g. &amp;#8199;
}

/**
 * Recover the preheader/preview text an email editor hides at the top of the
 * HTML body. Editors emit it as a visually-hidden element (display:none,
 * max-height:0, opacity:0, …) padded with invisible characters to stretch the
 * inbox snippet — we take the first such element's text, decode its entities,
 * and strip that padding. Returns "" when no hidden preheader is present.
 */
export function extractPreheader(html: string): string {
  if (!html) return "";
  // Preheaders sit at the very top of the body, but their invisible padding can
  // run to thousands of characters, so scan a generous leading window to be
  // sure the hidden element's closing tag is included.
  const head = html.slice(0, 40000);
  const hiddenTag =
    /<(?<tag>div|span|p|table|td)\b[^>]*style=(["'])(?<style>[^"']*)\2[^>]*>(?<inner>[\s\S]*?)<\/\k<tag>>/gi;
  let match: RegExpExecArray | null;
  while ((match = hiddenTag.exec(head)) !== null) {
    const style = (match.groups?.style ?? "").replace(/\s+/g, "").toLowerCase();
    const isHidden =
      style.includes("display:none") ||
      /max-height:0(px)?/.test(style) ||
      /(^|;)height:0(px)?/.test(style) ||
      /opacity:0(\.0*)?($|;)/.test(style) ||
      style.includes("font-size:0") ||
      style.includes("max-width:0");
    if (!isHidden) continue;
    const text = decodeEntities((match.groups?.inner ?? "").replace(/<[^>]+>/g, ""))
      .replace(PREHEADER_PADDING, "") // drop invisible snippet-stretcher chars
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * GET /templates/{id} — the stored template's Subject + HtmlBody, for the
 * editor's visual preview of the selected template. The body still carries its
 * `{{ placeholder }}` variables (Postmark renders them per-recipient at send
 * time); the preview shows the template's structure, not a resolved message.
 */
export async function getTemplateContent(
  templateId: number,
): Promise<PostmarkTemplateContent> {
  const token = requireToken();
  const response = await fetch(`${POSTMARK_API}/templates/${templateId}`, {
    headers: {
      Accept: "application/json",
      "X-Postmark-Server-Token": token,
    },
  });
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new PostmarkError(
      `Postmark template fetch failed (HTTP ${response.status})`,
      response.status,
      undefined,
      retryable,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    TemplateId?: number;
    Alias?: string | null;
    Name?: string;
    Subject?: string;
    HtmlBody?: string;
    TextBody?: string;
  };
  const htmlBody = payload.HtmlBody ?? "";
  return {
    templateId: payload.TemplateId ?? templateId,
    alias: payload.Alias ?? null,
    name: payload.Name ?? "",
    subject: payload.Subject ?? "",
    htmlBody,
    textBody: payload.TextBody ?? "",
    previewText: extractPreheader(htmlBody),
  };
}

/** GET /templates — for the editor's template picker (cache at the call site). */
export async function listTemplates(): Promise<PostmarkTemplate[]> {
  const token = requireToken();
  const response = await fetch(
    `${POSTMARK_API}/templates?count=300&offset=0`,
    {
      headers: {
        Accept: "application/json",
        "X-Postmark-Server-Token": token,
      },
    },
  );
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new PostmarkError(
      `Postmark templates list failed (HTTP ${response.status})`,
      response.status,
      undefined,
      retryable,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    Templates?: Array<{ TemplateId: number; Alias: string | null; Name: string }>;
  };
  return (payload.Templates ?? []).map((t) => ({
    templateId: t.TemplateId,
    alias: t.Alias,
    name: t.Name,
  }));
}

export interface TemplateSource {
  alias: string;
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

/**
 * Create or update a template by alias — for templates whose source lives in
 * this repo (see scripts/push-postmark-templates.ts), so the copy is reviewed
 * and versioned like code instead of existing only in Postmark's editor.
 *
 * Tries the update first; Postmark answers an unknown alias with HTTP 404 /
 * ErrorCode 1101, and only then is it created.
 */
export async function upsertTemplate(
  source: TemplateSource,
): Promise<{ templateId: number; created: boolean }> {
  const token = requireToken();
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Postmark-Server-Token": token,
  };
  const body = JSON.stringify({
    Name: source.name,
    Alias: source.alias,
    Subject: source.subject,
    HtmlBody: source.htmlBody,
    TextBody: source.textBody,
  });

  const call = async (method: "PUT" | "POST", path: string) => {
    const response = await fetch(`${POSTMARK_API}${path}`, { method, headers, body });
    const payload = (await response.json().catch(() => ({}))) as {
      TemplateId?: number;
      ErrorCode?: number;
      Message?: string;
    };
    return { response, payload };
  };

  let created = false;
  let { response, payload } = await call(
    "PUT",
    `/templates/${encodeURIComponent(source.alias)}`,
  );
  if (response.status === 404 || payload.ErrorCode === 1101) {
    created = true;
    ({ response, payload } = await call("POST", "/templates"));
  }
  if (!response.ok || (payload.ErrorCode ?? 0) !== 0 || !payload.TemplateId) {
    throw new PostmarkError(
      payload.Message ?? `Postmark template upsert failed (HTTP ${response.status})`,
      response.status,
      payload.ErrorCode || undefined,
      response.status === 429 || response.status >= 500,
    );
  }
  return { templateId: payload.TemplateId, created };
}
