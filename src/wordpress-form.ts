// 워드프레스 문의폼(Contact Form 7 / Gravity Forms / Elementor Forms) 순수 HTTP 제출 —
// A2F 후보 387건 정밀 재스캔 결과 CF7 128건(33%)·Elementor 56건(15%)·GravityForms 15건이
// 확인됐다(2026-09-15, wiki/scripts/wordpress-form-submit.py의 Python 버전에서 이식). 셋 다
// 헤드리스 브라우저 없이 fetch만으로 끝까지 처리 가능하다는 게 실측 확인됐다:
//   - Contact Form 7: <form action="...">이 멀쩡해 보여도 실제로는 항상 JS가 가로채 자체
//     REST API(/wp-json/contact-form-7/v1/contact-forms/{id}/feedback)로 제출한다. 필요한 hidden
//     필드(_wpcf7, _wpcf7_version 등)는 전부 페이지 HTML에 정적으로 있다.
//   - Gravity Forms: 기본 제출 방식이 gform_submission_method="postback" — AJAX가 아니라 그냥
//     같은 페이지로 돌아가는 표준 HTML POST다.
//   - Elementor (Pro) Forms: <form>에 action이 아예 없지만, 실제로는 워드프레스 표준 AJAX
//     엔드포인트(/wp-admin/admin-ajax.php)로 action=elementor_pro_forms_send_form과 함께
//     post_id/form_id/referer_title/queried_id(전부 페이지 HTML에 정적) + referrer(현재 페이지
//     URL)를 실어 POST한다. 필드명은 name="form_fields[실제필드키]" 형태.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchHtml(url: string): Promise<{ html: string; cookies: string[]; status: number }> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const html = await res.text();
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { html, cookies, status: res.status };
}

// plugin: null이 "CF7/GF/Elementor가 아니다"인지 "그 이전에 요청 자체가 막혔다"(Cloudflare 등
// WAF의 TLS 지문 차단 — UA/헤더 스푸핑으로는 안 뚫림, 2026-09-15 dh-robotics.com 실측)인지 호출한
// 에이전트가 구분 못 하면 둘 다 "폼을 못 찾음"으로 보여 다음 행동을 못 정한다. 서버 코드에 "그럴 땐
// Playwright를 써라" 식으로 특정 툴을 못박지 않고(호출측이 뭘 갖고 있는지 여긴 알 수 없다), 최신
// 대응 방법이 코드 재배포 없이도 갱신되도록 퀵스타트 문서 링크만 힌트로 실어보낸다.
const QUICKSTART_HINT = "See https://agenzax.ai/quickstart (FAQ: submission_method headless_browser) for what to try next.";

function cookieHeader(cookies: string[]): string {
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

interface Cf7Form {
  hidden: Record<string, string>;
  fillable: string[];
  selects: Record<string, [string, string][]>;
}

function findCf7Form(html: string): Cf7Form | null {
  const formRe = /<form\b[^>]*class="[^"]*wpcf7-form[^"]*"[^>]*>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = formRe.exec(html))) {
    const body = m[1];
    const hidden: Record<string, string> = {};
    const hiddenRe1 = /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
    let hm: RegExpExecArray | null;
    while ((hm = hiddenRe1.exec(body))) hidden[hm[1]] = unescapeHtml(hm[2]);
    const hiddenRe2 = /<input[^>]*type=["']hidden["'][^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
    while ((hm = hiddenRe2.exec(body))) if (!(hm[2] in hidden)) hidden[hm[2]] = unescapeHtml(hm[1]);
    if (!("_wpcf7" in hidden)) continue;

    const fillable: string[] = [];
    const fieldRe = /<(?:input|textarea)\b[^>]*name=["']([^"']+)["']/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body))) {
      const name = fm[1];
      if (name.startsWith("_wpcf7") || fillable.includes(name)) continue;
      fillable.push(name);
    }

    const selects: Record<string, [string, string][]> = {};
    const selectRe = /<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = selectRe.exec(body))) {
      const [, name, optionsHtml] = sm;
      if (name.startsWith("_wpcf7")) continue;
      const options: [string, string][] = [];
      const optRe = /<option\b[^>]*value=["']([^"']*)["'][^>]*>([^<]*)/gi;
      let om: RegExpExecArray | null;
      while ((om = optRe.exec(optionsHtml))) options.push([om[1], unescapeHtml(om[2]).trim()]);
      selects[name] = options;
      if (!fillable.includes(name)) fillable.push(name);
    }
    return { hidden, fillable, selects };
  }
  return null;
}

async function submitCf7(pageUrl: string, form: Cf7Form, fieldValues: Record<string, string>) {
  const missing = form.fillable.filter((f) => !(f in fieldValues));
  if (missing.length > 0) {
    return { status: "error", message: `필요한 필드 값이 없습니다: ${missing.join(", ")}`, fillable_fields: form.fillable, select_options: form.selects };
  }
  const invalidSelects: Record<string, unknown> = {};
  for (const [name, options] of Object.entries(form.selects)) {
    if (!options.some(([v]) => v === fieldValues[name])) {
      invalidSelects[name] = { given: fieldValues[name], valid_options: options };
    }
  }
  if (Object.keys(invalidSelects).length > 0) {
    return { status: "error", message: "select 필드에 유효하지 않은 값이 있습니다.", invalid_selects: invalidSelects };
  }

  const formId = form.hidden["_wpcf7"];
  const payload: Record<string, string> = { ...form.hidden };
  for (const name of form.fillable) payload[name] = fieldValues[name];

  const origin = new URL(pageUrl);
  const apiUrl = `${origin.protocol}//${origin.host}/wp-json/contact-form-7/v1/contact-forms/${formId}/feedback`;
  const body = new FormData();
  for (const [k, v] of Object.entries(payload)) body.append(k, v);

  const res = await fetch(apiUrl, { method: "POST", body, headers: { "User-Agent": UA, Referer: pageUrl } });
  const text = await res.text();
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  try {
    return JSON.parse(text);
  } catch {
    return { status: "error", message: `응답 파싱 실패: ${text.slice(0, 300)}` };
  }
}

interface GfForm {
  actionUrl: string;
  formId: string;
  hidden: Record<string, string>;
  fillable: string[];
}

function findGfForm(html: string, pageUrl: string): GfForm | null {
  const formTagMatch = /<form\b[^>]*id=["']gform_(\d+)["'][^>]*>/i.exec(html);
  if (!formTagMatch) return null;
  const formId = formTagMatch[1];
  const tag = formTagMatch[0];
  const actionMatch = /action=["']([^"']*)["']/i.exec(tag);
  const actionUrl = actionMatch ? new URL(actionMatch[1], pageUrl).toString() : pageUrl;

  const bodyMatch = new RegExp(`<form\\b[^>]*id=["']gform_${formId}["'][^>]*>([\\s\\S]*?)<\\/form>`, "i").exec(html);
  const body = bodyMatch ? bodyMatch[1] : "";

  const hidden: Record<string, string> = {};
  const hiddenRe1 = /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hiddenRe1.exec(body))) hidden[hm[1]] = unescapeHtml(hm[2]);
  const hiddenRe2 = /<input[^>]*type=["']hidden["'][^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
  while ((hm = hiddenRe2.exec(body))) if (!(hm[2] in hidden)) hidden[hm[2]] = unescapeHtml(hm[1]);
  if (!(`is_submit_${formId}` in hidden)) hidden[`is_submit_${formId}`] = "1";
  if (!("gform_submit" in hidden)) hidden["gform_submit"] = formId;

  const fillable: string[] = [];
  const fieldRe = /<(?:input|textarea|select)\b[^>]*name=["']([^"']+)["']/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(body))) {
    const name = fm[1];
    if (name in hidden || fillable.includes(name)) continue;
    const isHiddenType = new RegExp(`name=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*type=["']hidden["']`, "i").test(body);
    if (isHiddenType) continue;
    fillable.push(name);
  }
  return { actionUrl, formId, hidden, fillable };
}

async function submitGf(pageUrl: string, form: GfForm, fieldValues: Record<string, string>, cookies: string[]) {
  const payload: Record<string, string> = { ...form.hidden, ...fieldValues };
  const body = new FormData();
  for (const [k, v] of Object.entries(payload)) body.append(k, v);

  const headers: Record<string, string> = { "User-Agent": UA, Referer: pageUrl };
  const cookieStr = cookieHeader(cookies);
  if (cookieStr) headers["Cookie"] = cookieStr;

  const res = await fetch(form.actionUrl, { method: "POST", body, headers });
  const responseHtml = await res.text();
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}: ${responseHtml.slice(0, 300)}` };

  if (/gform_confirmation_message|gform_confirmation_wrapper/i.test(responseHtml)) {
    return { status: "mail_sent", message: "제출 성공(확인 메시지 감지)" };
  }
  if (/validation_error|gfield_error/i.test(responseHtml)) {
    const errors: string[] = [];
    const errRe = /<div[^>]*class="[^"]*gfield_description[^"]*validation_message[^"]*"[^>]*>([^<]*)/gi;
    let em: RegExpExecArray | null;
    while ((em = errRe.exec(responseHtml))) errors.push(em[1]);
    return { status: "validation_failed", message: "필드 검증 실패", errors };
  }
  return { status: "unknown", message: "성공/실패를 응답에서 판정하지 못함 — 페이지 구조가 다를 수 있음" };
}

interface ElementorForm {
  hidden: Record<string, string>;
  fillable: string[];
  selects: Record<string, [string, string][]>;
  ajaxUrl: string;
}

function findElementorForm(html: string, pageUrl: string): ElementorForm | null {
  const formMatch = /<form\b[^>]*class="[^"]*elementor-form[^"]*"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) return null;
  const body = formMatch[1];

  const hidden: Record<string, string> = {};
  const hiddenRe1 = /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hiddenRe1.exec(body))) hidden[hm[1]] = unescapeHtml(hm[2]);
  const hiddenRe2 = /<input[^>]*type=["']hidden["'][^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["']/gi;
  while ((hm = hiddenRe2.exec(body))) if (!(hm[2] in hidden)) hidden[hm[2]] = unescapeHtml(hm[1]);
  if (!("form_id" in hidden)) return null;

  const fillable: string[] = [];
  const fieldRe = /<(?:input|textarea|select)\b[^>]*name=["']form_fields\[([^\]]+)\]["']/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(body))) {
    const name = fm[1];
    if (!fillable.includes(name)) fillable.push(name);
  }

  const selects: Record<string, [string, string][]> = {};
  const selectRe = /<select\b[^>]*name=["']form_fields\[([^\]]+)\]["'][^>]*>([\s\S]*?)<\/select>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = selectRe.exec(body))) {
    const [, name, optionsHtml] = sm;
    const options: [string, string][] = [];
    const optRe = /<option\b[^>]*value=["']([^"']*)["'][^>]*>([^<]*)/gi;
    let om: RegExpExecArray | null;
    while ((om = optRe.exec(optionsHtml))) options.push([om[1], unescapeHtml(om[2]).trim()]);
    selects[name] = options;
  }

  const origin = new URL(pageUrl);
  const ajaxUrl = `${origin.protocol}//${origin.host}/wp-admin/admin-ajax.php`;
  return { hidden, fillable, selects, ajaxUrl };
}

async function submitElementor(pageUrl: string, form: ElementorForm, fieldValues: Record<string, string>) {
  const missing = form.fillable.filter((f) => !(f in fieldValues));
  if (missing.length > 0) {
    return { status: "error", message: `필요한 필드 값이 없습니다: ${missing.join(", ")}`, fillable_fields: form.fillable, select_options: form.selects };
  }

  const payload: Record<string, string> = { ...form.hidden };
  for (const name of form.fillable) payload[`form_fields[${name}]`] = fieldValues[name];
  payload["action"] = "elementor_pro_forms_send_form";
  payload["referrer"] = pageUrl;

  const body = new FormData();
  for (const [k, v] of Object.entries(payload)) body.append(k, v);

  const res = await fetch(form.ajaxUrl, { method: "POST", body, headers: { "User-Agent": UA, Referer: pageUrl } });
  const text = await res.text();
  if (!res.ok) return { status: "error", message: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  let resp: { success?: boolean; [key: string]: unknown };
  try {
    resp = JSON.parse(text);
  } catch {
    return { status: "error", message: `응답 파싱 실패: ${text.slice(0, 300)}` };
  }
  if (resp.success) return { status: "mail_sent", message: "제출 성공", response: resp };
  return { status: "error", message: "제출 실패", response: resp };
}

export async function inspectWordPressForm(pageUrl: string): Promise<Record<string, unknown>> {
  const { html, status } = await fetchHtml(pageUrl);
  const cf7 = findCf7Form(html);
  if (cf7) return { plugin: "contact_form_7", form_id: cf7.hidden["_wpcf7"], fillable_fields: cf7.fillable, select_options: cf7.selects };
  const gf = findGfForm(html, pageUrl);
  if (gf) return { plugin: "gravity_forms", form_id: gf.formId, action: gf.actionUrl, fillable_fields: gf.fillable };
  const el = findElementorForm(html, pageUrl);
  if (el) return { plugin: "elementor_forms", fillable_fields: el.fillable, select_options: el.selects };
  if (status >= 400) {
    return {
      plugin: null,
      http_status: status,
      message: `페이지 요청이 HTTP ${status}로 거부됐습니다 — WAF/봇 차단일 수 있습니다(User-Agent를 스푸핑해도 TLS 지문으로 막는 경우가 있어, 이 fetch 기반 툴로는 못 뚫을 수 있습니다).`,
      hint: QUICKSTART_HINT,
    };
  }
  return { plugin: null, message: "이 페이지에서 CF7/Gravity Forms/Elementor Forms 폼을 찾지 못했습니다.", hint: QUICKSTART_HINT };
}

export async function submitWordPressForm(pageUrl: string, fieldValues: Record<string, string>): Promise<Record<string, unknown>> {
  const { html, cookies, status } = await fetchHtml(pageUrl);
  const cf7 = findCf7Form(html);
  if (cf7) return submitCf7(pageUrl, cf7, fieldValues);
  const gf = findGfForm(html, pageUrl);
  if (gf) return submitGf(pageUrl, gf, fieldValues, cookies);
  const el = findElementorForm(html, pageUrl);
  if (el) return submitElementor(pageUrl, el, fieldValues);
  if (status >= 400) {
    return {
      status: "error",
      message: `페이지 요청이 HTTP ${status}로 거부됐습니다 — WAF/봇 차단일 수 있습니다(User-Agent를 스푸핑해도 TLS 지문으로 막는 경우가 있어, 이 fetch 기반 툴로는 못 뚫을 수 있습니다).`,
      hint: QUICKSTART_HINT,
    };
  }
  return { status: "error", message: "이 페이지에서 CF7/Gravity Forms/Elementor Forms 폼을 찾지 못했습니다.", hint: QUICKSTART_HINT };
}
