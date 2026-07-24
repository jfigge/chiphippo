// node_modules/marked/lib/marked.esm.js
function z() {
  return {
    async: false,
    breaks: false,
    extensions: null,
    gfm: true,
    hooks: null,
    pedantic: false,
    renderer: null,
    silent: false,
    tokenizer: null,
    walkTokens: null,
  };
}
var T = z();
function N(l3) {
  T = l3;
}
var _ = { exec: () => null };
function E(l3) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)),
      s = e[n];
    return (s || ((s = l3(n)), (e[n] = s)), s);
  };
}
function d(l3, e = "") {
  let t = typeof l3 == "string" ? l3 : l3.source,
    n = {
      replace: (s, r) => {
        let i = typeof r == "string" ? r : r.source;
        return ((i = i.replace(m.caret, "$1")), (t = t.replace(s, i)), n);
      },
      getRegex: () => new RegExp(t, e),
    };
  return n;
}
var Te = ((l3 = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l3);
  } catch {
    return false;
  }
})();
var m = {
  codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\] +\S/,
  listReplaceTask: /^\[[ xX]\] +/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (l3) => new RegExp(`^( {0,3}${l3})((?:[	 ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: E(
    (l3) =>
      new RegExp(`^ {0,${l3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`),
  ),
  hrRegex: E(
    (l3) =>
      new RegExp(
        `^ {0,${l3}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`,
      ),
  ),
  fencesBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}#`)),
  htmlBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}<(?:[a-z].*>|!--)`, "i")),
  blockquoteBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}>`)),
};
var Oe = /^(?:[ \t]*(?:\n|$))+/;
var we = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var ye =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var B = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Pe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var j = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var oe =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var ae = d(oe)
  .replace(/bull/g, j)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/\|table/g, "")
  .getRegex();
var Se = d(oe)
  .replace(/bull/g, j)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
var F =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var $e = /^[^\n]+/;
var U = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var Le = d(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace("label", U)
  .replace(
    "title",
    /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/,
  )
  .getRegex();
var _e = d(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, j)
  .getRegex();
var H =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var K = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var Me = d(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))",
  "i",
)
  .replace("comment", K)
  .replace("tag", H)
  .replace(
    "attribute",
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .getRegex();
var le = (l3) =>
  d(F)
    .replace("hr", B)
    .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
    .replace("|lheading", "")
    .replace("|table", "")
    .replace("blockquote", " {0,3}>")
    .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~~~)[^\\n]*\\n")
    .replace("list", l3)
    .replace(
      "html",
      "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)",
    )
    .replace("tag", H)
    .getRegex();
var ze = le(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ee = le(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var Ce = d(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/)
  .replace("paragraph", Ee)
  .getRegex();
var W = {
  blockquote: Ce,
  code: we,
  def: Le,
  fences: ye,
  heading: Pe,
  hr: B,
  html: Me,
  lheading: ae,
  list: _e,
  newline: Oe,
  paragraph: ze,
  table: _,
  text: $e,
};
var se = d(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .replace("hr", B)
  .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
  .replace("blockquote", " {0,3}>")
  .replace("code", "(?: {4}| {0,3}	)[^\\n]")
  .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~~~)[^\\n]*\\n")
  .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]")
  .replace(
    "html",
    "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)",
  )
  .replace("tag", H)
  .getRegex();
var Ae = {
  ...W,
  lheading: Se,
  table: se,
  paragraph: d(F)
    .replace("hr", B)
    .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
    .replace("|lheading", "")
    .replace("table", se)
    .replace("blockquote", " {0,3}>")
    .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~~~)[^\\n]*\\n")
    .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]")
    .replace(
      "html",
      "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)",
    )
    .replace("tag", H)
    .getRegex(),
};
var Ie = {
  ...W,
  html: d(
    `^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`,
  )
    .replace("comment", K)
    .replace(
      /tag/g,
      "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b",
    )
    .getRegex(),
  def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,
  heading: /^(#{1,6})(.*)(?:\n+|$)/,
  fences: _,
  lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,
  paragraph: d(F)
    .replace("hr", B)
    .replace(
      "heading",
      ` *#{1,6} *[^
]`,
    )
    .replace("lheading", ae)
    .replace("|table", "")
    .replace("blockquote", " {0,3}>")
    .replace("|fences", "")
    .replace("|list", "")
    .replace("|html", "")
    .replace("|tag", "")
    .getRegex(),
};
var Be = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var qe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var ue = /^( {2,}|\\)\n(?!\s*$)/;
var De =
  /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var C = /[\p{P}\p{S}]/u;
var Z = /[\s\p{P}\p{S}]/u;
var X = /[^\s\p{P}\p{S}]/u;
var ve = d(/^((?![*_])punctSpace)/, "u")
  .replace(/punctSpace/g, Z)
  .getRegex();
var pe = /(?!~)[\p{P}\p{S}]/u;
var He = /(?!~)[\s\p{P}\p{S}]/u;
var Ze = /(?:[^\s\p{P}\p{S}]|~)/u;
var Ge = d(/link|precode-code|html/, "g")
  .replace(
    "link",
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace("precode-", Te ? "(?<!`)()" : "(^^|[^`])")
  .replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace("html", /<(?! )[^<>]*?>/)
  .getRegex();
var ce = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var Ne = d(ce, "u").replace(/punct/g, C).getRegex();
var Qe = d(ce, "u").replace(/punct/g, pe).getRegex();
var he =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var je = d(he, "gu")
  .replace(/notPunctSpace/g, X)
  .replace(/punctSpace/g, Z)
  .replace(/punct/g, C)
  .getRegex();
var Fe = d(he, "gu")
  .replace(/notPunctSpace/g, Ze)
  .replace(/punctSpace/g, He)
  .replace(/punct/g, pe)
  .getRegex();
var Ue = d(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
  "gu",
)
  .replace(/notPunctSpace/g, X)
  .replace(/punctSpace/g, Z)
  .replace(/punct/g, C)
  .getRegex();
var Ke = d(/^~~?(?:((?!~)punct)|[^\s~])/, "u")
  .replace(/punct/g, C)
  .getRegex();
var We =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var Xe = d(We, "gu")
  .replace(/notPunctSpace/g, X)
  .replace(/punctSpace/g, Z)
  .replace(/punct/g, C)
  .getRegex();
var Je = d(/\\(punct)/, "gu")
  .replace(/punct/g, C)
  .getRegex();
var Ve = d(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace(
    "email",
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .getRegex();
var Ye = d(K).replace("(?:-->|$)", "-->").getRegex();
var et = d(
  "^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
)
  .replace("comment", Ye)
  .replace(
    "attribute",
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .getRegex();
var v =
  /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
var tt = d(
  /^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/,
)
  .replace("label", v)
  .replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace(
    "title",
    /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/,
  )
  .getRegex();
var ke = d(/^!?\[(label)\]\[(ref)\]/)
  .replace("label", v)
  .replace("ref", U)
  .getRegex();
var de = d(/^!?\[(ref)\](?:\[\])?/)
  .replace("ref", U)
  .getRegex();
var nt = d("reflink|nolink(?!\\()", "g")
  .replace("reflink", ke)
  .replace("nolink", de)
  .getRegex();
var ie = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var J = {
  _backpedal: _,
  anyPunctuation: Je,
  autolink: Ve,
  blockSkip: Ge,
  br: ue,
  code: qe,
  del: _,
  delLDelim: _,
  delRDelim: _,
  emStrongLDelim: Ne,
  emStrongRDelimAst: je,
  emStrongRDelimUnd: Ue,
  escape: Be,
  link: tt,
  nolink: de,
  punctuation: ve,
  reflink: ke,
  reflinkSearch: nt,
  tag: et,
  text: De,
  url: _,
};
var rt = {
  ...J,
  link: d(/^!?\[(label)\]\((.*?)\)/)
    .replace("label", v)
    .getRegex(),
  reflink: d(/^!?\[(label)\]\s*\[([^\]]*)\]/)
    .replace("label", v)
    .getRegex(),
};
var Q = {
  ...J,
  emStrongRDelimAst: Fe,
  emStrongLDelim: Qe,
  delLDelim: Ke,
  delRDelim: Xe,
  url: d(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace("protocol", ie)
    .replace(
      "email",
      /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/,
    )
    .getRegex(),
  _backpedal:
    /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  text: d(
    /^(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/,
  )
    .replace("protocol", ie)
    .getRegex(),
};
var st = {
  ...Q,
  br: d(ue).replace("{2,}", "*").getRegex(),
  text: d(Q.text)
    .replace("\\b_", "\\b_| {2,}\\n")
    .replace(/\{2,\}/g, "*")
    .getRegex(),
};
var q = { normal: W, gfm: Ae, pedantic: Ie };
var A = { normal: J, gfm: Q, breaks: st, pedantic: rt };
var it = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
var ge = (l3) => it[l3];
function O(l3, e) {
  if (e) {
    if (m.escapeTest.test(l3)) return l3.replace(m.escapeReplace, ge);
  } else if (m.escapeTestNoEncode.test(l3))
    return l3.replace(m.escapeReplaceNoEncode, ge);
  return l3;
}
function V(l3) {
  try {
    l3 = encodeURI(l3).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return l3;
}
function Y(l3, e) {
  let t = l3.replace(m.findPipe, (r, i, o) => {
      let u = false,
        a = i;
      for (; --a >= 0 && o[a] === "\\";) u = !u;
      return u ? "|" : " |";
    }),
    n = t.split(m.splitPipe),
    s = 0;
  if (
    (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e)
  )
    if (n.length > e) n.splice(e);
    else for (; n.length < e;) n.push("");
  for (; s < n.length; s++) n[s] = n[s].trim().replace(m.slashPipe, "|");
  return n;
}
function $(l3, e, t) {
  let n = l3.length;
  if (n === 0) return "";
  let s = 0;
  for (; s < n;) {
    let r = l3.charAt(n - s - 1);
    if (r === e && !t) s++;
    else if (r !== e && t) s++;
    else break;
  }
  return l3.slice(0, n - s);
}
function ee(l3) {
  let e = l3.split(`
`),
    t = e.length - 1;
  for (; t >= 0 && m.blankLine.test(e[t]);) t--;
  return e.length - t <= 2
    ? l3
    : e.slice(0, t + 1).join(`
`);
}
function fe(l3, e) {
  if (l3.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < l3.length; n++)
    if (l3[n] === "\\") n++;
    else if (l3[n] === e[0]) t++;
    else if (l3[n] === e[1] && (t--, t < 0)) return n;
  return t > 0 ? -2 : -1;
}
function me(l3, e = 0) {
  let t = e,
    n = "";
  for (let s of l3)
    if (s === "	") {
      let r = 4 - (t % 4);
      ((n += " ".repeat(r)), (t += r));
    } else ((n += s), t++);
  return n;
}
function xe(l3, e, t, n, s) {
  let r = e.href,
    i = e.title || null,
    o = l3[1].replace(s.other.outputLinkReplace, "$1");
  n.state.inLink = true;
  let u = {
    type: l3[0].charAt(0) === "!" ? "image" : "link",
    raw: t,
    href: r,
    title: i,
    text: o,
    tokens: n.inlineTokens(o),
  };
  return ((n.state.inLink = false), u);
}
function ot(l3, e, t) {
  let n = l3.match(t.other.indentCodeCompensation);
  if (n === null) return e;
  let s = n[1];
  return e
    .split(
      `
`,
    )
    .map((r) => {
      let i = r.match(t.other.beginningSpace);
      if (i === null) return r;
      let [o] = i;
      return o.length >= s.length ? r.slice(s.length) : r;
    }).join(`
`);
}
var w = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0) return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ee(t[0]),
        s = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0],
        s = ot(n, t[3] || "", this.rules);
      return {
        type: "code",
        raw: n,
        lang: t[2]
          ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1")
          : t[2],
        text: s,
      };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let s = $(n, "#");
        (this.options.pedantic ||
          !s ||
          this.rules.other.endingSpaceChar.test(s)) &&
          (n = s.trim());
      }
      return {
        type: "heading",
        raw: $(
          t[0],
          `
`,
        ),
        depth: t[1].length,
        text: n,
        tokens: this.lexer.inline(n),
      };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t)
      return {
        type: "hr",
        raw: $(
          t[0],
          `
`,
        ),
      };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = $(
          t[0],
          `
`,
        ).split(`
`),
        s = "",
        r = "",
        i = [];
      for (; n.length > 0;) {
        let o = false,
          u = [],
          a;
        for (a = 0; a < n.length; a++)
          if (this.rules.other.blockquoteStart.test(n[a]))
            (u.push(n[a]), (o = true));
          else if (!o) u.push(n[a]);
          else break;
        n = n.slice(a);
        let p = u.join(`
`),
          c = p
            .replace(
              this.rules.other.blockquoteSetextReplace,
              `
    $1`,
            )
            .replace(this.rules.other.blockquoteSetextReplace2, "");
        ((s = s
          ? `${s}
${p}`
          : p),
          (r = r
            ? `${r}
${c}`
            : c));
        let h = this.lexer.state.top;
        if (
          ((this.lexer.state.top = true),
          this.lexer.blockTokens(c, i, true),
          (this.lexer.state.top = h),
          n.length === 0)
        )
          break;
        let k = i.at(-1);
        if (k?.type === "code") break;
        if (k?.type === "blockquote") {
          let R = k,
            f =
              R.raw +
              `
` +
              n.join(`
`),
            S = this.blockquote(f);
          ((i[i.length - 1] = S),
            (s = s.substring(0, s.length - R.raw.length) + S.raw),
            (r = r.substring(0, r.length - R.text.length) + S.text));
          break;
        } else if (k?.type === "list") {
          let R = k,
            f =
              R.raw +
              `
` +
              n.join(`
`),
            S = this.list(f);
          ((i[i.length - 1] = S),
            (s = s.substring(0, s.length - k.raw.length) + S.raw),
            (r = r.substring(0, r.length - R.raw.length) + S.raw),
            (n = f.substring(i.at(-1).raw.length).split(`
`)));
          continue;
        }
      }
      return { type: "blockquote", raw: s, tokens: i, text: r };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = t[1].trim(),
        s = n.length > 1,
        r = {
          type: "list",
          raw: "",
          ordered: s,
          start: s ? +n.slice(0, -1) : "",
          loose: false,
          items: [],
        };
      ((n = s ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`),
        this.options.pedantic && (n = s ? n : "[*+-]"));
      let i = this.rules.other.listItemRegex(n),
        o = false;
      for (; e;) {
        let a = false,
          p = "",
          c = "";
        if (!(t = i.exec(e)) || this.rules.block.hr.test(e)) break;
        ((p = t[0]), (e = e.substring(p.length)));
        let h = me(
            t[2].split(
              `
`,
              1,
            )[0],
            t[1].length,
          ),
          k = e.split(
            `
`,
            1,
          )[0],
          R = !h.trim(),
          f = 0;
        if (
          (this.options.pedantic
            ? ((f = 2), (c = h.trimStart()))
            : R
              ? (f = t[1].length + 1)
              : ((f = h.search(this.rules.other.nonSpaceChar)),
                (f = f > 4 ? 1 : f),
                (c = h.slice(f)),
                (f += t[1].length)),
          R &&
            this.rules.other.blankLine.test(k) &&
            ((p +=
              k +
              `
`),
            (e = e.substring(k.length + 1)),
            (a = true)),
          !a)
        ) {
          let S = this.rules.other.nextBulletRegex(f),
            te = this.rules.other.hrRegex(f),
            ne = this.rules.other.fencesBeginRegex(f),
            re = this.rules.other.headingBeginRegex(f),
            be = this.rules.other.htmlBeginRegex(f),
            Re = this.rules.other.blockquoteBeginRegex(f);
          for (; e;) {
            let G = e.split(
                `
`,
                1,
              )[0],
              I;
            if (
              ((k = G),
              this.options.pedantic
                ? ((k = k.replace(this.rules.other.listReplaceNesting, "  ")),
                  (I = k))
                : (I = k.replace(this.rules.other.tabCharGlobal, "    ")),
              ne.test(k) ||
                re.test(k) ||
                be.test(k) ||
                Re.test(k) ||
                S.test(k) ||
                te.test(k))
            )
              break;
            if (I.search(this.rules.other.nonSpaceChar) >= f || !k.trim())
              c +=
                `
` + I.slice(f);
            else {
              if (
                R ||
                h
                  .replace(this.rules.other.tabCharGlobal, "    ")
                  .search(this.rules.other.nonSpaceChar) >= 4 ||
                ne.test(h) ||
                re.test(h) ||
                te.test(h)
              )
                break;
              c +=
                `
` + k;
            }
            ((R = !k.trim()),
              (p +=
                G +
                `
`),
              (e = e.substring(G.length + 1)),
              (h = I.slice(f)));
          }
        }
        (r.loose ||
          (o
            ? (r.loose = true)
            : this.rules.other.doubleBlankLine.test(p) && (o = true)),
          r.items.push({
            type: "list_item",
            raw: p,
            task: !!this.options.gfm && this.rules.other.listIsTask.test(c),
            loose: false,
            text: c,
            tokens: [],
          }),
          (r.raw += p));
      }
      let u = r.items.at(-1);
      if (u) ((u.raw = u.raw.trimEnd()), (u.text = u.text.trimEnd()));
      else return;
      r.raw = r.raw.trimEnd();
      for (let a of r.items) {
        ((this.lexer.state.top = false),
          (a.tokens = this.lexer.blockTokens(a.text, [])));
        let p = a.tokens[0];
        if (a.task && (p?.type === "text" || p?.type === "paragraph")) {
          ((a.text = a.text.replace(this.rules.other.listReplaceTask, "")),
            (p.raw = p.raw.replace(this.rules.other.listReplaceTask, "")),
            (p.text = p.text.replace(this.rules.other.listReplaceTask, "")));
          for (let h = this.lexer.inlineQueue.length - 1; h >= 0; h--)
            if (
              this.rules.other.listIsTask.test(this.lexer.inlineQueue[h].src)
            ) {
              this.lexer.inlineQueue[h].src = this.lexer.inlineQueue[
                h
              ].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          let c = this.rules.other.listTaskCheckbox.exec(a.raw);
          if (c) {
            let h = {
              type: "checkbox",
              raw: c[0] + " ",
              checked: c[0] !== "[ ]",
            };
            ((a.checked = h.checked),
              r.loose
                ? a.tokens[0] &&
                  ["paragraph", "text"].includes(a.tokens[0].type) &&
                  "tokens" in a.tokens[0] &&
                  a.tokens[0].tokens
                  ? ((a.tokens[0].raw = h.raw + a.tokens[0].raw),
                    (a.tokens[0].text = h.raw + a.tokens[0].text),
                    a.tokens[0].tokens.unshift(h))
                  : a.tokens.unshift({
                      type: "paragraph",
                      raw: h.raw,
                      text: h.raw,
                      tokens: [h],
                    })
                : a.tokens.unshift(h));
          }
        } else a.task && (a.task = false);
        if (!r.loose) {
          let c = a.tokens.filter((k) => k.type === "space"),
            h =
              c.length > 0 &&
              c.some((k) => this.rules.other.anyLine.test(k.raw));
          r.loose = h;
        }
      }
      if (r.loose)
        for (let a of r.items) {
          a.loose = true;
          for (let p of a.tokens) p.type === "text" && (p.type = "paragraph");
        }
      return r;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ee(t[0]);
      return {
        type: "html",
        block: true,
        raw: n,
        pre: t[1] === "pre" || t[1] === "script" || t[1] === "style",
        text: n,
      };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let n = t[1]
          .toLowerCase()
          .replace(this.rules.other.multipleSpaceGlobal, " "),
        s = t[2]
          ? t[2]
              .replace(this.rules.other.hrefBrackets, "$1")
              .replace(this.rules.inline.anyPunctuation, "$1")
          : "",
        r = t[3]
          ? t[3]
              .substring(1, t[3].length - 1)
              .replace(this.rules.inline.anyPunctuation, "$1")
          : t[3];
      return {
        type: "def",
        tag: n,
        raw: $(
          t[0],
          `
`,
        ),
        href: s,
        title: r,
      };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
    let n = Y(t[1]),
      s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"),
      r = t[3]?.trim()
        ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`)
        : [],
      i = {
        type: "table",
        raw: $(
          t[0],
          `
`,
        ),
        header: [],
        align: [],
        rows: [],
      };
    if (n.length === s.length) {
      for (let o of s)
        this.rules.other.tableAlignRight.test(o)
          ? i.align.push("right")
          : this.rules.other.tableAlignCenter.test(o)
            ? i.align.push("center")
            : this.rules.other.tableAlignLeft.test(o)
              ? i.align.push("left")
              : i.align.push(null);
      for (let o = 0; o < n.length; o++)
        i.header.push({
          text: n[o],
          tokens: this.lexer.inline(n[o]),
          header: true,
          align: i.align[o],
        });
      for (let o of r)
        i.rows.push(
          Y(o, i.header.length).map((u, a) => ({
            text: u,
            tokens: this.lexer.inline(u),
            header: false,
            align: i.align[a],
          })),
        );
      return i;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return {
        type: "heading",
        raw: $(
          t[0],
          `
`,
        ),
        depth: t[2].charAt(0) === "=" ? 1 : 2,
        text: n,
        tokens: this.lexer.inline(n),
      };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n =
        t[1].charAt(t[1].length - 1) ===
        `
`
          ? t[1].slice(0, -1)
          : t[1];
      return {
        type: "paragraph",
        raw: t[0],
        text: n,
        tokens: this.lexer.inline(n),
      };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t)
      return {
        type: "text",
        raw: t[0],
        text: t[0],
        tokens: this.lexer.inline(t[0]),
      };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t) return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t)
      return (
        !this.lexer.state.inLink && this.rules.other.startATag.test(t[0])
          ? (this.lexer.state.inLink = true)
          : this.lexer.state.inLink &&
            this.rules.other.endATag.test(t[0]) &&
            (this.lexer.state.inLink = false),
        !this.lexer.state.inRawBlock &&
        this.rules.other.startPreScriptTag.test(t[0])
          ? (this.lexer.state.inRawBlock = true)
          : this.lexer.state.inRawBlock &&
            this.rules.other.endPreScriptTag.test(t[0]) &&
            (this.lexer.state.inRawBlock = false),
        {
          type: "html",
          raw: t[0],
          inLink: this.lexer.state.inLink,
          inRawBlock: this.lexer.state.inRawBlock,
          block: false,
          text: t[0],
        }
      );
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[2].trim();
      if (
        !this.options.pedantic &&
        this.rules.other.startAngleBracket.test(n)
      ) {
        if (!this.rules.other.endAngleBracket.test(n)) return;
        let i = $(n.slice(0, -1), "\\");
        if ((n.length - i.length) % 2 === 0) return;
      } else {
        let i = fe(t[2], "()");
        if (i === -2) return;
        if (i > -1) {
          let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
          ((t[2] = t[2].substring(0, i)),
            (t[0] = t[0].substring(0, u).trim()),
            (t[3] = ""));
        }
      }
      let s = t[2],
        r = "";
      if (this.options.pedantic) {
        let i = this.rules.other.pedanticHrefTitle.exec(s);
        i && ((s = i[1]), (r = i[3]));
      } else r = t[3] ? t[3].slice(1, -1) : "";
      return (
        (s = s.trim()),
        this.rules.other.startAngleBracket.test(s) &&
          (this.options.pedantic && !this.rules.other.endAngleBracket.test(n)
            ? (s = s.slice(1))
            : (s = s.slice(1, -1))),
        xe(
          t,
          {
            href: s && s.replace(this.rules.inline.anyPunctuation, "$1"),
            title: r && r.replace(this.rules.inline.anyPunctuation, "$1"),
          },
          t[0],
          this.lexer,
          this.rules,
        )
      );
    }
  }
  reflink(e, t) {
    let n;
    if (
      (n = this.rules.inline.reflink.exec(e)) ||
      (n = this.rules.inline.nolink.exec(e))
    ) {
      let s = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "),
        r = t[s.toLowerCase()];
      if (!r) {
        let i = n[0].charAt(0);
        return { type: "text", raw: i, text: i };
      }
      return xe(n, r, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (
      !s ||
      (!s[1] && !s[2] && !s[3] && !s[4]) ||
      (s[4] && n.match(this.rules.other.unicodeAlphaNumeric))
    )
      return;
    if (!(s[1] || s[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let i = [...s[0]].length - 1,
        o,
        u,
        a = i,
        p = 0,
        c =
          s[0][0] === "*"
            ? this.rules.inline.emStrongRDelimAst
            : this.rules.inline.emStrongRDelimUnd;
      for (
        c.lastIndex = 0, t = t.slice(-1 * e.length + i);
        (s = c.exec(t)) !== null;
      ) {
        if (((o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6]), !o)) continue;
        if (((u = [...o].length), s[3] || s[4])) {
          a += u;
          continue;
        } else if ((s[5] || s[6]) && i % 3 && !((i + u) % 3)) {
          p += u;
          continue;
        }
        if (((a -= u), a > 0)) continue;
        u = Math.min(u, u + a + p);
        let h = [...s[0]][0].length,
          k = e.slice(0, i + s.index + h + u);
        if (Math.min(i, u) % 2) {
          let f = k.slice(1, -1);
          return {
            type: "em",
            raw: k,
            text: f,
            tokens: this.lexer.inlineTokens(f),
          };
        }
        let R = k.slice(2, -2);
        return {
          type: "strong",
          raw: k,
          text: R,
          tokens: this.lexer.inlineTokens(R),
        };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "),
        s = this.rules.other.nonSpaceChar.test(n),
        r =
          this.rules.other.startingSpaceChar.test(n) &&
          this.rules.other.endingSpaceChar.test(n);
      return (
        s && r && (n = n.substring(1, n.length - 1)),
        { type: "codespan", raw: t[0], text: n }
      );
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t) return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s) return;
    if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let i = [...s[0]].length - 1,
        o,
        u,
        a = i,
        p = this.rules.inline.delRDelim;
      for (
        p.lastIndex = 0, t = t.slice(-1 * e.length + i);
        (s = p.exec(t)) !== null;
      ) {
        if (
          ((o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6]),
          !o || ((u = [...o].length), u !== i))
        )
          continue;
        if (s[3] || s[4]) {
          a += u;
          continue;
        }
        if (((a -= u), a > 0)) continue;
        u = Math.min(u, u + a);
        let c = [...s[0]][0].length,
          h = e.slice(0, i + s.index + c + u),
          k = h.slice(i, -i);
        return {
          type: "del",
          raw: h,
          text: k,
          tokens: this.lexer.inlineTokens(k),
        };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, s;
      return (
        t[2] === "@"
          ? ((n = t[1]), (s = "mailto:" + n))
          : ((n = t[1]), (s = n)),
        {
          type: "link",
          raw: t[0],
          text: n,
          href: s,
          tokens: [{ type: "text", raw: n, text: n }],
        }
      );
    }
  }
  url(e) {
    let t;
    if ((t = this.rules.inline.url.exec(e))) {
      let n, s;
      if (t[2] === "@") ((n = t[0]), (s = "mailto:" + n));
      else {
        let r;
        do
          ((r = t[0]),
            (t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? ""));
        while (r !== t[0]);
        ((n = t[0]), t[1] === "www." ? (s = "http://" + t[0]) : (s = t[0]));
      }
      return {
        type: "link",
        raw: t[0],
        text: n,
        href: s,
        tokens: [{ type: "text", raw: n, text: n }],
      };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: t[0], escaped: n };
    }
  }
};
var x = class l {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    ((this.tokens = []),
      (this.tokens.links = /* @__PURE__ */ Object.create(null)),
      (this.options = e || T),
      (this.options.tokenizer = this.options.tokenizer || new w()),
      (this.tokenizer = this.options.tokenizer),
      (this.tokenizer.options = this.options),
      (this.tokenizer.lexer = this),
      (this.inlineQueue = []),
      (this.state = { inLink: false, inRawBlock: false, top: true }));
    let t = { other: m, block: q.normal, inline: A.normal };
    (this.options.pedantic
      ? ((t.block = q.pedantic), (t.inline = A.pedantic))
      : this.options.gfm &&
        ((t.block = q.gfm),
        this.options.breaks ? (t.inline = A.breaks) : (t.inline = A.gfm)),
      (this.tokenizer.rules = t));
  }
  static get rules() {
    return { block: q, inline: A };
  }
  static lex(e, t) {
    return new l(t).lex(e);
  }
  static lexInline(e, t) {
    return new l(t).inlineTokens(e);
  }
  lex(e) {
    ((e = e.replace(
      m.carriageReturn,
      `
`,
    )),
      this.blockTokens(e, this.tokens));
    for (let t = 0; t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return ((this.inlineQueue = []), this.tokens);
  }
  blockTokens(e, t = [], n = false) {
    ((this.tokenizer.lexer = this),
      this.options.pedantic &&
        (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, "")));
    let s = 1 / 0;
    for (; e;) {
      if (e.length < s) s = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (
        this.options.extensions?.block?.some((o) =>
          (r = o.call({ lexer: this }, e, t))
            ? ((e = e.substring(r.raw.length)), t.push(r), true)
            : false,
        )
      )
        continue;
      if ((r = this.tokenizer.space(e))) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        r.raw.length === 1 && o !== void 0
          ? (o.raw += `
`)
          : t.push(r);
        continue;
      }
      if ((r = this.tokenizer.code(e))) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "paragraph" || o?.type === "text"
          ? ((o.raw +=
              (o.raw.endsWith(`
`)
                ? ""
                : `
`) + r.raw),
            (o.text +=
              `
` + r.text),
            (this.inlineQueue.at(-1).src = o.text))
          : t.push(r);
        continue;
      }
      if ((r = this.tokenizer.fences(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.heading(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.hr(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.blockquote(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.list(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.html(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.def(e))) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "paragraph" || o?.type === "text"
          ? ((o.raw +=
              (o.raw.endsWith(`
`)
                ? ""
                : `
`) + r.raw),
            (o.text +=
              `
` + r.raw),
            (this.inlineQueue.at(-1).src = o.text))
          : this.tokens.links[r.tag] ||
            ((this.tokens.links[r.tag] = { href: r.href, title: r.title }),
            t.push(r));
        continue;
      }
      if ((r = this.tokenizer.table(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      if ((r = this.tokenizer.lheading(e))) {
        ((e = e.substring(r.raw.length)), t.push(r));
        continue;
      }
      let i = e;
      if (this.options.extensions?.startBlock) {
        let o = 1 / 0,
          u = e.slice(1),
          a;
        (this.options.extensions.startBlock.forEach((p) => {
          ((a = p.call({ lexer: this }, u)),
            typeof a == "number" && a >= 0 && (o = Math.min(o, a)));
        }),
          o < 1 / 0 && o >= 0 && (i = e.substring(0, o + 1)));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(i))) {
        let o = t.at(-1);
        (n && o?.type === "paragraph"
          ? ((o.raw +=
              (o.raw.endsWith(`
`)
                ? ""
                : `
`) + r.raw),
            (o.text +=
              `
` + r.text),
            this.inlineQueue.pop(),
            (this.inlineQueue.at(-1).src = o.text))
          : t.push(r),
          (n = i.length !== e.length),
          (e = e.substring(r.raw.length)));
        continue;
      }
      if ((r = this.tokenizer.text(e))) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "text"
          ? ((o.raw +=
              (o.raw.endsWith(`
`)
                ? ""
                : `
`) + r.raw),
            (o.text +=
              `
` + r.text),
            this.inlineQueue.pop(),
            (this.inlineQueue.at(-1).src = o.text))
          : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return ((this.state.top = true), t);
  }
  inline(e, t = []) {
    return (this.inlineQueue.push({ src: e, tokens: t }), t);
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = e;
    if (this.tokens.links) {
      let o = Object.keys(this.tokens.links);
      o.length > 0 &&
        (n = n.replace(this.tokenizer.rules.inline.reflinkSearch, (u) =>
          o.includes(u.slice(u.lastIndexOf("[") + 1, -1))
            ? "[" + "a".repeat(u.length - 2) + "]"
            : u,
        ));
    }
    ((n = n.replace(this.tokenizer.rules.inline.anyPunctuation, "++")),
      (n = n.replace(this.tokenizer.rules.inline.blockSkip, (o, u, a) => {
        let p = a ? a.length : 0;
        return o.slice(0, p) + "[" + "a".repeat(o.length - p - 2) + "]";
      })),
      (n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n));
    let s = false,
      r = "",
      i = 1 / 0;
    for (; e;) {
      if (e.length < i) i = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      (s || (r = ""), (s = false));
      let o;
      if (
        this.options.extensions?.inline?.some((a) =>
          (o = a.call({ lexer: this }, e, t))
            ? ((e = e.substring(o.raw.length)), t.push(o), true)
            : false,
        )
      )
        continue;
      if ((o = this.tokenizer.escape(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.tag(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.link(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.reflink(e, this.tokens.links))) {
        e = e.substring(o.raw.length);
        let a = t.at(-1);
        o.type === "text" && a?.type === "text"
          ? ((a.raw += o.raw), (a.text += o.text))
          : t.push(o);
        continue;
      }
      if ((o = this.tokenizer.emStrong(e, n, r))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.codespan(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.br(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.del(e, n, r))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if ((o = this.tokenizer.autolink(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      if (!this.state.inLink && (o = this.tokenizer.url(e))) {
        ((e = e.substring(o.raw.length)), t.push(o));
        continue;
      }
      let u = e;
      if (this.options.extensions?.startInline) {
        let a = 1 / 0,
          p = e.slice(1),
          c;
        (this.options.extensions.startInline.forEach((h) => {
          ((c = h.call({ lexer: this }, p)),
            typeof c == "number" && c >= 0 && (a = Math.min(a, c)));
        }),
          a < 1 / 0 && a >= 0 && (u = e.substring(0, a + 1)));
      }
      if ((o = this.tokenizer.inlineText(u))) {
        ((e = e.substring(o.raw.length)),
          o.raw.slice(-1) !== "_" && (r = o.raw.slice(-1)),
          (s = true));
        let a = t.at(-1);
        a?.type === "text" ? ((a.raw += o.raw), (a.text += o.text)) : t.push(o);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent) console.error(t);
    else throw new Error(t);
  }
};
var y = class {
  options;
  parser;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let s = (t || "").match(m.notSpaceStart)?.[0],
      r =
        e.replace(m.endingNewline, "") +
        `
`;
    return s
      ? '<pre><code class="language-' +
          O(s) +
          '">' +
          (n ? r : O(r, true)) +
          `</code></pre>
`
      : "<pre><code>" +
          (n ? r : O(r, true)) +
          `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let t = e.ordered,
      n = e.start,
      s = "";
    for (let o = 0; o < e.items.length; o++) {
      let u = e.items[o];
      s += this.listitem(u);
    }
    let r = t ? "ol" : "ul",
      i = t && n !== 1 ? ' start="' + n + '"' : "";
    return (
      "<" +
      r +
      i +
      `>
` +
      s +
      "</" +
      r +
      `>
`
    );
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return (
      "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> '
    );
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "",
      n = "";
    for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
    t += this.tablerow({ text: n });
    let s = "";
    for (let r = 0; r < e.rows.length; r++) {
      let i = e.rows[r];
      n = "";
      for (let o = 0; o < i.length; o++) n += this.tablecell(i[o]);
      s += this.tablerow({ text: n });
    }
    return (
      s && (s = `<tbody>${s}</tbody>`),
      `<table>
<thead>
` +
        t +
        `</thead>
` +
        s +
        `</table>
`
    );
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens),
      n = e.header ? "th" : "td";
    return (
      (e.align ? `<${n} align="${e.align}">` : `<${n}>`) +
      t +
      `</${n}>
`
    );
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${O(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, tokens: n }) {
    let s = this.parser.parseInline(n),
      r = V(e);
    if (r === null) return s;
    e = r;
    let i = '<a href="' + e + '"';
    return (t && (i += ' title="' + O(t) + '"'), (i += ">" + s + "</a>"), i);
  }
  image({ href: e, title: t, text: n, tokens: s }) {
    s && (n = this.parser.parseInline(s, this.parser.textRenderer));
    let r = V(e);
    if (r === null) return O(n);
    e = r;
    let i = `<img src="${e}" alt="${O(n)}"`;
    return (t && (i += ` title="${O(t)}"`), (i += ">"), i);
  }
  text(e) {
    return "tokens" in e && e.tokens
      ? this.parser.parseInline(e.tokens)
      : "escaped" in e && e.escaped
        ? e.text
        : O(e.text);
  }
};
var L = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var b = class l2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    ((this.options = e || T),
      (this.options.renderer = this.options.renderer || new y()),
      (this.renderer = this.options.renderer),
      (this.renderer.options = this.options),
      (this.renderer.parser = this),
      (this.textRenderer = new L()));
  }
  static parse(e, t) {
    return new l2(t).parse(e);
  }
  static parseInline(e, t) {
    return new l2(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0; n < e.length; n++) {
      let s = e[n];
      if (this.options.extensions?.renderers?.[s.type]) {
        let i = s,
          o = this.options.extensions.renderers[i.type].call(
            { parser: this },
            i,
          );
        if (
          o !== false ||
          ![
            "space",
            "hr",
            "heading",
            "code",
            "table",
            "blockquote",
            "list",
            "html",
            "def",
            "paragraph",
            "text",
          ].includes(i.type)
        ) {
          t += o || "";
          continue;
        }
      }
      let r = s;
      switch (r.type) {
        case "space": {
          t += this.renderer.space(r);
          break;
        }
        case "hr": {
          t += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t += this.renderer.heading(r);
          break;
        }
        case "code": {
          t += this.renderer.code(r);
          break;
        }
        case "table": {
          t += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t += this.renderer.html(r);
          break;
        }
        case "def": {
          t += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t += this.renderer.text(r);
          break;
        }
        default: {
          let i = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent) return (console.error(i), "");
          throw new Error(i);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let s = 0; s < e.length; s++) {
      let r = e[s];
      if (this.options.extensions?.renderers?.[r.type]) {
        let o = this.options.extensions.renderers[r.type].call(
          { parser: this },
          r,
        );
        if (
          o !== false ||
          ![
            "escape",
            "html",
            "link",
            "image",
            "strong",
            "em",
            "codespan",
            "br",
            "del",
            "text",
          ].includes(r.type)
        ) {
          n += o || "";
          continue;
        }
      }
      let i = r;
      switch (i.type) {
        case "escape": {
          n += t.text(i);
          break;
        }
        case "html": {
          n += t.html(i);
          break;
        }
        case "link": {
          n += t.link(i);
          break;
        }
        case "image": {
          n += t.image(i);
          break;
        }
        case "checkbox": {
          n += t.checkbox(i);
          break;
        }
        case "strong": {
          n += t.strong(i);
          break;
        }
        case "em": {
          n += t.em(i);
          break;
        }
        case "codespan": {
          n += t.codespan(i);
          break;
        }
        case "br": {
          n += t.br(i);
          break;
        }
        case "del": {
          n += t.del(i);
          break;
        }
        case "text": {
          n += t.text(i);
          break;
        }
        default: {
          let o = 'Token with "' + i.type + '" type was not found.';
          if (this.options.silent) return (console.error(o), "");
          throw new Error(o);
        }
      }
    }
    return n;
  }
};
var P = class {
  options;
  block;
  constructor(e) {
    this.options = e || T;
  }
  static passThroughHooks = /* @__PURE__ */ new Set([
    "preprocess",
    "postprocess",
    "processAllTokens",
    "emStrongMask",
  ]);
  static passThroughHooksRespectAsync = /* @__PURE__ */ new Set([
    "preprocess",
    "postprocess",
    "processAllTokens",
  ]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? x.lex : x.lexInline;
  }
  provideParser(e = this.block) {
    return e ? b.parse : b.parseInline;
  }
};
var D = class {
  defaults = z();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b;
  Renderer = y;
  TextRenderer = L;
  Lexer = x;
  Tokenizer = w;
  Hooks = P;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let s of e)
      switch (((n = n.concat(t.call(this, s))), s.type)) {
        case "table": {
          let r = s;
          for (let i of r.header) n = n.concat(this.walkTokens(i.tokens, t));
          for (let i of r.rows)
            for (let o of i) n = n.concat(this.walkTokens(o.tokens, t));
          break;
        }
        case "list": {
          let r = s;
          n = n.concat(this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = s;
          this.defaults.extensions?.childTokens?.[r.type]
            ? this.defaults.extensions.childTokens[r.type].forEach((i) => {
                let o = r[i].flat(1 / 0);
                n = n.concat(this.walkTokens(o, t));
              })
            : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t)));
        }
      }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return (
      e.forEach((n) => {
        let s = { ...n };
        if (
          ((s.async = this.defaults.async || s.async || false),
          n.extensions &&
            (n.extensions.forEach((r) => {
              if (!r.name) throw new Error("extension name required");
              if ("renderer" in r) {
                let i = t.renderers[r.name];
                i
                  ? (t.renderers[r.name] = function (...o) {
                      let u = r.renderer.apply(this, o);
                      return (u === false && (u = i.apply(this, o)), u);
                    })
                  : (t.renderers[r.name] = r.renderer);
              }
              if ("tokenizer" in r) {
                if (!r.level || (r.level !== "block" && r.level !== "inline"))
                  throw new Error(
                    "extension level must be 'block' or 'inline'",
                  );
                let i = t[r.level];
                (i ? i.unshift(r.tokenizer) : (t[r.level] = [r.tokenizer]),
                  r.start &&
                    (r.level === "block"
                      ? t.startBlock
                        ? t.startBlock.push(r.start)
                        : (t.startBlock = [r.start])
                      : r.level === "inline" &&
                        (t.startInline
                          ? t.startInline.push(r.start)
                          : (t.startInline = [r.start]))));
              }
              "childTokens" in r &&
                r.childTokens &&
                (t.childTokens[r.name] = r.childTokens);
            }),
            (s.extensions = t)),
          n.renderer)
        ) {
          let r = this.defaults.renderer || new y(this.defaults);
          for (let i in n.renderer) {
            if (!(i in r)) throw new Error(`renderer '${i}' does not exist`);
            if (["options", "parser"].includes(i)) continue;
            let o = i,
              u = n.renderer[o],
              a = r[o];
            r[o] = (...p) => {
              let c = u.apply(r, p);
              return (c === false && (c = a.apply(r, p)), c || "");
            };
          }
          s.renderer = r;
        }
        if (n.tokenizer) {
          let r = this.defaults.tokenizer || new w(this.defaults);
          for (let i in n.tokenizer) {
            if (!(i in r)) throw new Error(`tokenizer '${i}' does not exist`);
            if (["options", "rules", "lexer"].includes(i)) continue;
            let o = i,
              u = n.tokenizer[o],
              a = r[o];
            r[o] = (...p) => {
              let c = u.apply(r, p);
              return (c === false && (c = a.apply(r, p)), c);
            };
          }
          s.tokenizer = r;
        }
        if (n.hooks) {
          let r = this.defaults.hooks || new P();
          for (let i in n.hooks) {
            if (!(i in r)) throw new Error(`hook '${i}' does not exist`);
            if (["options", "block"].includes(i)) continue;
            let o = i,
              u = n.hooks[o],
              a = r[o];
            P.passThroughHooks.has(i)
              ? (r[o] = (p) => {
                  if (
                    this.defaults.async &&
                    P.passThroughHooksRespectAsync.has(i)
                  )
                    return (async () => {
                      let h = await u.call(r, p);
                      return a.call(r, h);
                    })();
                  let c = u.call(r, p);
                  return a.call(r, c);
                })
              : (r[o] = (...p) => {
                  if (this.defaults.async)
                    return (async () => {
                      let h = await u.apply(r, p);
                      return (h === false && (h = await a.apply(r, p)), h);
                    })();
                  let c = u.apply(r, p);
                  return (c === false && (c = a.apply(r, p)), c);
                });
          }
          s.hooks = r;
        }
        if (n.walkTokens) {
          let r = this.defaults.walkTokens,
            i = n.walkTokens;
          s.walkTokens = function (o) {
            let u = [];
            return (
              u.push(i.call(this, o)),
              r && (u = u.concat(r.call(this, o))),
              u
            );
          };
        }
        this.defaults = { ...this.defaults, ...s };
      }),
      this
    );
  }
  setOptions(e) {
    return ((this.defaults = { ...this.defaults, ...e }), this);
  }
  lexer(e, t) {
    return x.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return b.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, s) => {
      let r = { ...s },
        i = { ...this.defaults, ...r },
        o = this.onError(!!i.silent, !!i.async);
      if (this.defaults.async === true && r.async === false)
        return o(
          new Error(
            "marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise.",
          ),
        );
      if (typeof n > "u" || n === null)
        return o(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string")
        return o(
          new Error(
            "marked(): input parameter is of type " +
              Object.prototype.toString.call(n) +
              ", string expected",
          ),
        );
      if ((i.hooks && ((i.hooks.options = i), (i.hooks.block = e)), i.async))
        return (async () => {
          let u = i.hooks ? await i.hooks.preprocess(n) : n,
            p = await (
              i.hooks ? await i.hooks.provideLexer(e) : e ? x.lex : x.lexInline
            )(u, i),
            c = i.hooks ? await i.hooks.processAllTokens(p) : p;
          i.walkTokens && (await Promise.all(this.walkTokens(c, i.walkTokens)));
          let k = await (
            i.hooks
              ? await i.hooks.provideParser(e)
              : e
                ? b.parse
                : b.parseInline
          )(c, i);
          return i.hooks ? await i.hooks.postprocess(k) : k;
        })().catch(o);
      try {
        i.hooks && (n = i.hooks.preprocess(n));
        let a = (i.hooks ? i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(
          n,
          i,
        );
        (i.hooks && (a = i.hooks.processAllTokens(a)),
          i.walkTokens && this.walkTokens(a, i.walkTokens));
        let c = (
          i.hooks ? i.hooks.provideParser(e) : e ? b.parse : b.parseInline
        )(a, i);
        return (i.hooks && (c = i.hooks.postprocess(c)), c);
      } catch (u) {
        return o(u);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (
        ((n.message += `
Please report this to https://github.com/markedjs/marked.`),
        e)
      ) {
        let s =
          "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(s) : s;
      }
      if (t) return Promise.reject(n);
      throw n;
    };
  }
};
var M = new D();
function g(l3, e) {
  return M.parse(l3, e);
}
g.options = g.setOptions = function (l3) {
  return (M.setOptions(l3), (g.defaults = M.defaults), N(g.defaults), g);
};
g.getDefaults = z;
g.defaults = T;
g.use = function (...l3) {
  return (M.use(...l3), (g.defaults = M.defaults), N(g.defaults), g);
};
g.walkTokens = function (l3, e) {
  return M.walkTokens(l3, e);
};
g.parseInline = M.parseInline;
g.Parser = b;
g.parser = b.parse;
g.Renderer = y;
g.TextRenderer = L;
g.Lexer = x;
g.lexer = x.lex;
g.Tokenizer = w;
g.Hooks = P;
g.parse = g;
var Kt = g.options;
var Wt = g.setOptions;
var Xt = g.use;
var Jt = g.walkTokens;
var Vt = g.parseInline;
var en = b.parse;
var tn = x.lex;

// node_modules/dompurify/dist/purify.es.mjs
function _arrayLikeToArray(r, a) {
  (null == a || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
  return n;
}
function _arrayWithHoles(r) {
  if (Array.isArray(r)) return r;
}
function _iterableToArrayLimit(r, l3) {
  var t =
    null == r
      ? null
      : ("undefined" != typeof Symbol && r[Symbol.iterator]) || r["@@iterator"];
  if (null != t) {
    var e,
      n,
      i,
      u,
      a = [],
      f = true,
      o = false;
    try {
      if (((i = (t = t.call(r)).next), 0 === l3));
      else
        for (
          ;
          !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l3);
          f = true
        );
    } catch (r2) {
      ((o = true), (n = r2));
    } finally {
      try {
        if (!f && null != t.return && ((u = t.return()), Object(u) !== u))
          return;
      } finally {
        if (o) throw n;
      }
    }
    return a;
  }
}
function _nonIterableRest() {
  throw new TypeError(
    "Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.",
  );
}
function _slicedToArray(r, e) {
  return (
    _arrayWithHoles(r) ||
    _iterableToArrayLimit(r, e) ||
    _unsupportedIterableToArray(r, e) ||
    _nonIterableRest()
  );
}
function _unsupportedIterableToArray(r, a) {
  if (r) {
    if ("string" == typeof r) return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return (
      "Object" === t && r.constructor && (t = r.constructor.name),
      "Map" === t || "Set" === t
        ? Array.from(r)
        : "Arguments" === t ||
            /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t)
          ? _arrayLikeToArray(r, a)
          : void 0
    );
  }
}
var entries = Object.entries;
var setPrototypeOf = Object.setPrototypeOf;
var isFrozen = Object.isFrozen;
var getPrototypeOf = Object.getPrototypeOf;
var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var freeze = Object.freeze;
var seal = Object.seal;
var create = Object.create;
var _ref = typeof Reflect !== "undefined" && Reflect;
var apply = _ref.apply;
var construct = _ref.construct;
if (!freeze) {
  freeze = function freeze2(x2) {
    return x2;
  };
}
if (!seal) {
  seal = function seal2(x2) {
    return x2;
  };
}
if (!apply) {
  apply = function apply2(func, thisArg) {
    for (
      var _len = arguments.length,
        args = new Array(_len > 2 ? _len - 2 : 0),
        _key = 2;
      _key < _len;
      _key++
    ) {
      args[_key - 2] = arguments[_key];
    }
    return func.apply(thisArg, args);
  };
}
if (!construct) {
  construct = function construct2(Func) {
    for (
      var _len2 = arguments.length,
        args = new Array(_len2 > 1 ? _len2 - 1 : 0),
        _key2 = 1;
      _key2 < _len2;
      _key2++
    ) {
      args[_key2 - 1] = arguments[_key2];
    }
    return new Func(...args);
  };
}
var arrayForEach = unapply(Array.prototype.forEach);
var arrayLastIndexOf = unapply(Array.prototype.lastIndexOf);
var arrayPop = unapply(Array.prototype.pop);
var arrayPush = unapply(Array.prototype.push);
var arraySplice = unapply(Array.prototype.splice);
var arrayIsArray = Array.isArray;
var stringToLowerCase = unapply(String.prototype.toLowerCase);
var stringToString = unapply(String.prototype.toString);
var stringMatch = unapply(String.prototype.match);
var stringReplace = unapply(String.prototype.replace);
var stringIndexOf = unapply(String.prototype.indexOf);
var stringTrim = unapply(String.prototype.trim);
var numberToString = unapply(Number.prototype.toString);
var booleanToString = unapply(Boolean.prototype.toString);
var bigintToString =
  typeof BigInt === "undefined" ? null : unapply(BigInt.prototype.toString);
var symbolToString =
  typeof Symbol === "undefined" ? null : unapply(Symbol.prototype.toString);
var objectHasOwnProperty = unapply(Object.prototype.hasOwnProperty);
var objectToString = unapply(Object.prototype.toString);
var regExpTest = unapply(RegExp.prototype.test);
var typeErrorCreate = unconstruct(TypeError);
function unapply(func) {
  return function (thisArg) {
    if (thisArg instanceof RegExp) {
      thisArg.lastIndex = 0;
    }
    for (
      var _len3 = arguments.length,
        args = new Array(_len3 > 1 ? _len3 - 1 : 0),
        _key3 = 1;
      _key3 < _len3;
      _key3++
    ) {
      args[_key3 - 1] = arguments[_key3];
    }
    return apply(func, thisArg, args);
  };
}
function unconstruct(Func) {
  return function () {
    for (
      var _len4 = arguments.length, args = new Array(_len4), _key4 = 0;
      _key4 < _len4;
      _key4++
    ) {
      args[_key4] = arguments[_key4];
    }
    return construct(Func, args);
  };
}
function addToSet(set, array) {
  let transformCaseFunc =
    arguments.length > 2 && arguments[2] !== void 0
      ? arguments[2]
      : stringToLowerCase;
  if (setPrototypeOf) {
    setPrototypeOf(set, null);
  }
  if (!arrayIsArray(array)) {
    return set;
  }
  let l3 = array.length;
  while (l3--) {
    let element = array[l3];
    if (typeof element === "string") {
      const lcElement = transformCaseFunc(element);
      if (lcElement !== element) {
        if (!isFrozen(array)) {
          array[l3] = lcElement;
        }
        element = lcElement;
      }
    }
    set[element] = true;
  }
  return set;
}
function cleanArray(array) {
  for (let index = 0; index < array.length; index++) {
    const isPropertyExist = objectHasOwnProperty(array, index);
    if (!isPropertyExist) {
      array[index] = null;
    }
  }
  return array;
}
function clone(object) {
  const newObject = create(null);
  for (const _ref2 of entries(object)) {
    var _ref3 = _slicedToArray(_ref2, 2);
    const property = _ref3[0];
    const value = _ref3[1];
    const isPropertyExist = objectHasOwnProperty(object, property);
    if (isPropertyExist) {
      if (arrayIsArray(value)) {
        newObject[property] = cleanArray(value);
      } else if (
        value &&
        typeof value === "object" &&
        value.constructor === Object
      ) {
        newObject[property] = clone(value);
      } else {
        newObject[property] = value;
      }
    }
  }
  return newObject;
}
function stringifyValue(value) {
  switch (typeof value) {
    case "string": {
      return value;
    }
    case "number": {
      return numberToString(value);
    }
    case "boolean": {
      return booleanToString(value);
    }
    case "bigint": {
      return bigintToString ? bigintToString(value) : "0";
    }
    case "symbol": {
      return symbolToString ? symbolToString(value) : "Symbol()";
    }
    case "undefined": {
      return objectToString(value);
    }
    case "function":
    case "object": {
      if (value === null) {
        return objectToString(value);
      }
      const valueAsRecord = value;
      const valueToString = lookupGetter(valueAsRecord, "toString");
      if (typeof valueToString === "function") {
        const stringified = valueToString(valueAsRecord);
        return typeof stringified === "string"
          ? stringified
          : objectToString(stringified);
      }
      return objectToString(value);
    }
    default: {
      return objectToString(value);
    }
  }
}
function lookupGetter(object, prop) {
  while (object !== null) {
    const desc = getOwnPropertyDescriptor(object, prop);
    if (desc) {
      if (desc.get) {
        return unapply(desc.get);
      }
      if (typeof desc.value === "function") {
        return unapply(desc.value);
      }
    }
    object = getPrototypeOf(object);
  }
  function fallbackValue() {
    return null;
  }
  return fallbackValue;
}
function isRegex(value) {
  try {
    regExpTest(value, "");
    return true;
  } catch (_unused) {
    return false;
  }
}
var html$1 = freeze([
  "a",
  "abbr",
  "acronym",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "big",
  "blink",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "content",
  "data",
  "datalist",
  "dd",
  "decorator",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "element",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "map",
  "mark",
  "marquee",
  "menu",
  "menuitem",
  "meter",
  "nav",
  "nobr",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "search",
  "section",
  "select",
  "shadow",
  "slot",
  "small",
  "source",
  "spacer",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);
var svg$1 = freeze([
  "svg",
  "a",
  "altglyph",
  "altglyphdef",
  "altglyphitem",
  "animatecolor",
  "animatemotion",
  "animatetransform",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "enterkeyhint",
  "exportparts",
  "filter",
  "font",
  "g",
  "glyph",
  "glyphref",
  "hkern",
  "image",
  "inputmode",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "mpath",
  "part",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tref",
  "tspan",
  "view",
  "vkern",
]);
var svgFilters = freeze([
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
]);
var svgDisallowed = freeze([
  "animate",
  "color-profile",
  "cursor",
  "discard",
  "font-face",
  "font-face-format",
  "font-face-name",
  "font-face-src",
  "font-face-uri",
  "foreignobject",
  "hatch",
  "hatchpath",
  "mesh",
  "meshgradient",
  "meshpatch",
  "meshrow",
  "missing-glyph",
  "script",
  "set",
  "solidcolor",
  "unknown",
  "use",
]);
var mathMl$1 = freeze([
  "math",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mglyph",
  "mi",
  "mlabeledtr",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "ms",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msup",
  "msubsup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "mprescripts",
]);
var mathMlDisallowed = freeze([
  "maction",
  "maligngroup",
  "malignmark",
  "mlongdiv",
  "mscarries",
  "mscarry",
  "msgroup",
  "mstack",
  "msline",
  "msrow",
  "semantics",
  "annotation",
  "annotation-xml",
  "mprescripts",
  "none",
]);
var text = freeze(["#text"]);
var html = freeze([
  "accept",
  "action",
  "align",
  "alt",
  "autocapitalize",
  "autocomplete",
  "autopictureinpicture",
  "autoplay",
  "background",
  "bgcolor",
  "border",
  "capture",
  "cellpadding",
  "cellspacing",
  "checked",
  "cite",
  "class",
  "clear",
  "color",
  "cols",
  "colspan",
  "command",
  "commandfor",
  "controls",
  "controlslist",
  "coords",
  "crossorigin",
  "datetime",
  "decoding",
  "default",
  "dir",
  "disabled",
  "disablepictureinpicture",
  "disableremoteplayback",
  "download",
  "draggable",
  "enctype",
  "enterkeyhint",
  "exportparts",
  "face",
  "for",
  "headers",
  "height",
  "hidden",
  "high",
  "href",
  "hreflang",
  "id",
  "inert",
  "inputmode",
  "integrity",
  "ismap",
  "kind",
  "label",
  "lang",
  "list",
  "loading",
  "loop",
  "low",
  "max",
  "maxlength",
  "media",
  "method",
  "min",
  "minlength",
  "multiple",
  "muted",
  "name",
  "nonce",
  "noshade",
  "novalidate",
  "nowrap",
  "open",
  "optimum",
  "part",
  "pattern",
  "placeholder",
  "playsinline",
  "popover",
  "popovertarget",
  "popovertargetaction",
  "poster",
  "preload",
  "pubdate",
  "radiogroup",
  "readonly",
  "rel",
  "required",
  "rev",
  "reversed",
  "role",
  "rows",
  "rowspan",
  "spellcheck",
  "scope",
  "selected",
  "shape",
  "size",
  "sizes",
  "slot",
  "span",
  "srclang",
  "start",
  "src",
  "srcset",
  "step",
  "style",
  "summary",
  "tabindex",
  "title",
  "translate",
  "type",
  "usemap",
  "valign",
  "value",
  "width",
  "wrap",
  "xmlns",
]);
var svg = freeze([
  "accent-height",
  "accumulate",
  "additive",
  "alignment-baseline",
  "amplitude",
  "ascent",
  "attributename",
  "attributetype",
  "azimuth",
  "basefrequency",
  "baseline-shift",
  "begin",
  "bias",
  "by",
  "class",
  "clip",
  "clippathunits",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "diffuseconstant",
  "direction",
  "display",
  "divisor",
  "dominant-baseline",
  "dur",
  "edgemode",
  "elevation",
  "end",
  "exponent",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "filterunits",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "fx",
  "fy",
  "g1",
  "g2",
  "glyph-name",
  "glyphref",
  "gradientunits",
  "gradienttransform",
  "height",
  "href",
  "id",
  "image-rendering",
  "in",
  "in2",
  "intercept",
  "k",
  "k1",
  "k2",
  "k3",
  "k4",
  "kerning",
  "keypoints",
  "keysplines",
  "keytimes",
  "lang",
  "lengthadjust",
  "letter-spacing",
  "kernelmatrix",
  "kernelunitlength",
  "lighting-color",
  "local",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "maskcontentunits",
  "maskunits",
  "max",
  "mask",
  "mask-type",
  "media",
  "method",
  "mode",
  "min",
  "name",
  "numoctaves",
  "offset",
  "operator",
  "opacity",
  "order",
  "orient",
  "orientation",
  "origin",
  "overflow",
  "paint-order",
  "path",
  "pathlength",
  "patterncontentunits",
  "patterntransform",
  "patternunits",
  "points",
  "preservealpha",
  "preserveaspectratio",
  "primitiveunits",
  "r",
  "rx",
  "ry",
  "radius",
  "refx",
  "refy",
  "repeatcount",
  "repeatdur",
  "restart",
  "result",
  "rotate",
  "scale",
  "seed",
  "shape-rendering",
  "slope",
  "specularconstant",
  "specularexponent",
  "spreadmethod",
  "startoffset",
  "stddeviation",
  "stitchtiles",
  "stop-color",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke",
  "stroke-width",
  "style",
  "surfacescale",
  "systemlanguage",
  "tabindex",
  "tablevalues",
  "targetx",
  "targety",
  "transform",
  "transform-origin",
  "text-anchor",
  "text-decoration",
  "text-orientation",
  "text-rendering",
  "textlength",
  "type",
  "u1",
  "u2",
  "unicode",
  "values",
  "viewbox",
  "visibility",
  "version",
  "vert-adv-y",
  "vert-origin-x",
  "vert-origin-y",
  "width",
  "word-spacing",
  "wrap",
  "writing-mode",
  "xchannelselector",
  "ychannelselector",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
  "z",
  "zoomandpan",
]);
var mathMl = freeze([
  "accent",
  "accentunder",
  "align",
  "bevelled",
  "close",
  "columnalign",
  "columnlines",
  "columnspacing",
  "columnspan",
  "denomalign",
  "depth",
  "dir",
  "display",
  "displaystyle",
  "encoding",
  "fence",
  "frame",
  "height",
  "href",
  "id",
  "largeop",
  "length",
  "linethickness",
  "lquote",
  "lspace",
  "mathbackground",
  "mathcolor",
  "mathsize",
  "mathvariant",
  "maxsize",
  "minsize",
  "movablelimits",
  "notation",
  "numalign",
  "open",
  "rowalign",
  "rowlines",
  "rowspacing",
  "rowspan",
  "rspace",
  "rquote",
  "scriptlevel",
  "scriptminsize",
  "scriptsizemultiplier",
  "selection",
  "separator",
  "separators",
  "stretchy",
  "subscriptshift",
  "supscriptshift",
  "symmetric",
  "voffset",
  "width",
  "xmlns",
]);
var xml = freeze([
  "xlink:href",
  "xml:id",
  "xlink:title",
  "xml:space",
  "xmlns:xlink",
]);
var MUSTACHE_EXPR = seal(/{{[\w\W]*|^[\w\W]*}}/g);
var ERB_EXPR = seal(/<%[\w\W]*|^[\w\W]*%>/g);
var TMPLIT_EXPR = seal(/\${[\w\W]*/g);
var DATA_ATTR = seal(/^data-[\-\w.\u00B7-\uFFFF]+$/);
var ARIA_ATTR = seal(/^aria-[\-\w]+$/);
var IS_ALLOWED_URI = seal(
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  // eslint-disable-line no-useless-escape
);
var IS_SCRIPT_OR_DATA = seal(/^(?:\w+script|data):/i);
var ATTR_WHITESPACE = seal(
  /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g,
  // eslint-disable-line no-control-regex
);
var DOCTYPE_NAME = seal(/^html$/i);
var CUSTOM_ELEMENT = seal(/^[a-z][.\w]*(-[.\w]+)+$/i);
var ELEMENT_MARKUP_PROBE = seal(/<[/\w!]/g);
var COMMENT_MARKUP_PROBE = seal(/<[/\w]/g);
var FALLBACK_TAG_CLOSE = seal(/<\/no(script|embed|frames)/i);
var SELF_CLOSING_TAG = seal(/\/>/i);
var NODE_TYPE = {
  element: 1,
  attribute: 2,
  text: 3,
  cdataSection: 4,
  entityReference: 5,
  // Deprecated
  entityNode: 6,
  // Deprecated
  processingInstruction: 7,
  comment: 8,
  document: 9,
  documentType: 10,
  documentFragment: 11,
  notation: 12,
  // Deprecated
};
var getGlobal = function getGlobal2() {
  return typeof window === "undefined" ? null : window;
};
var _createTrustedTypesPolicy = function _createTrustedTypesPolicy2(
  trustedTypes,
  purifyHostElement,
) {
  if (
    typeof trustedTypes !== "object" ||
    typeof trustedTypes.createPolicy !== "function"
  ) {
    return null;
  }
  let suffix = null;
  const ATTR_NAME = "data-tt-policy-suffix";
  if (purifyHostElement && purifyHostElement.hasAttribute(ATTR_NAME)) {
    suffix = purifyHostElement.getAttribute(ATTR_NAME);
  }
  const policyName = "dompurify" + (suffix ? "#" + suffix : "");
  try {
    return trustedTypes.createPolicy(policyName, {
      createHTML(html2) {
        return html2;
      },
      createScriptURL(scriptUrl) {
        return scriptUrl;
      },
    });
  } catch (_2) {
    console.warn(
      "TrustedTypes policy " + policyName + " could not be created.",
    );
    return null;
  }
};
var _createHooksMap = function _createHooksMap2() {
  return {
    afterSanitizeAttributes: [],
    afterSanitizeElements: [],
    afterSanitizeShadowDOM: [],
    beforeSanitizeAttributes: [],
    beforeSanitizeElements: [],
    beforeSanitizeShadowDOM: [],
    uponSanitizeAttribute: [],
    uponSanitizeElement: [],
    uponSanitizeShadowNode: [],
  };
};
var _resolveSetOption = function _resolveSetOption2(
  cfg,
  key,
  fallback,
  options,
) {
  return objectHasOwnProperty(cfg, key) && arrayIsArray(cfg[key])
    ? addToSet(
        options.base ? clone(options.base) : {},
        cfg[key],
        options.transform,
      )
    : fallback;
};
function createDOMPurify() {
  let window2 =
    arguments.length > 0 && arguments[0] !== void 0
      ? arguments[0]
      : getGlobal();
  const DOMPurify = (root) => createDOMPurify(root);
  DOMPurify.version = "3.4.12";
  DOMPurify.removed = [];
  if (
    !window2 ||
    !window2.document ||
    window2.document.nodeType !== NODE_TYPE.document ||
    !window2.Element
  ) {
    DOMPurify.isSupported = false;
    return DOMPurify;
  }
  let document = window2.document;
  const originalDocument = document;
  const currentScript = originalDocument.currentScript;
  window2.DocumentFragment;
  const HTMLTemplateElement = window2.HTMLTemplateElement,
    Node = window2.Node,
    Element = window2.Element,
    NodeFilter = window2.NodeFilter,
    _window$NamedNodeMap = window2.NamedNodeMap;
  _window$NamedNodeMap === void 0
    ? window2.NamedNodeMap || window2.MozNamedAttrMap
    : _window$NamedNodeMap;
  window2.HTMLFormElement;
  const DOMParser = window2.DOMParser,
    trustedTypes = window2.trustedTypes;
  const ElementPrototype = Element.prototype;
  const cloneNode = lookupGetter(ElementPrototype, "cloneNode");
  const remove = lookupGetter(ElementPrototype, "remove");
  const getNextSibling = lookupGetter(ElementPrototype, "nextSibling");
  const getChildNodes = lookupGetter(ElementPrototype, "childNodes");
  const getParentNode = lookupGetter(ElementPrototype, "parentNode");
  const getShadowRoot = lookupGetter(ElementPrototype, "shadowRoot");
  const getAttributes = lookupGetter(ElementPrototype, "attributes");
  const getNodeType =
    Node && Node.prototype ? lookupGetter(Node.prototype, "nodeType") : null;
  const getNodeName =
    Node && Node.prototype ? lookupGetter(Node.prototype, "nodeName") : null;
  if (typeof HTMLTemplateElement === "function") {
    const template = document.createElement("template");
    if (template.content && template.content.ownerDocument) {
      document = template.content.ownerDocument;
    }
  }
  let trustedTypesPolicy;
  let emptyHTML = "";
  let defaultTrustedTypesPolicy;
  let defaultTrustedTypesPolicyResolved = false;
  let IN_TRUSTED_TYPES_POLICY = 0;
  const _assertNotInTrustedTypesPolicy =
    function _assertNotInTrustedTypesPolicy2() {
      if (IN_TRUSTED_TYPES_POLICY > 0) {
        throw typeErrorCreate(
          'A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.',
        );
      }
    };
  const _createTrustedHTML = function _createTrustedHTML2(html2) {
    _assertNotInTrustedTypesPolicy();
    IN_TRUSTED_TYPES_POLICY++;
    try {
      return trustedTypesPolicy.createHTML(html2);
    } finally {
      IN_TRUSTED_TYPES_POLICY--;
    }
  };
  const _createTrustedScriptURL = function _createTrustedScriptURL2(scriptUrl) {
    _assertNotInTrustedTypesPolicy();
    IN_TRUSTED_TYPES_POLICY++;
    try {
      return trustedTypesPolicy.createScriptURL(scriptUrl);
    } finally {
      IN_TRUSTED_TYPES_POLICY--;
    }
  };
  const _getDefaultTrustedTypesPolicy =
    function _getDefaultTrustedTypesPolicy2() {
      if (!defaultTrustedTypesPolicyResolved) {
        defaultTrustedTypesPolicy = _createTrustedTypesPolicy(
          trustedTypes,
          currentScript,
        );
        defaultTrustedTypesPolicyResolved = true;
      }
      return defaultTrustedTypesPolicy;
    };
  const _document = document,
    implementation = _document.implementation,
    createNodeIterator = _document.createNodeIterator,
    createDocumentFragment = _document.createDocumentFragment,
    getElementsByTagName = _document.getElementsByTagName;
  const importNode = originalDocument.importNode;
  let hooks = _createHooksMap();
  DOMPurify.isSupported =
    typeof entries === "function" &&
    typeof getParentNode === "function" &&
    implementation &&
    implementation.createHTMLDocument !== void 0;
  const MUSTACHE_EXPR$1 = MUSTACHE_EXPR,
    ERB_EXPR$1 = ERB_EXPR,
    TMPLIT_EXPR$1 = TMPLIT_EXPR,
    DATA_ATTR$1 = DATA_ATTR,
    ARIA_ATTR$1 = ARIA_ATTR,
    IS_SCRIPT_OR_DATA$1 = IS_SCRIPT_OR_DATA,
    ATTR_WHITESPACE$1 = ATTR_WHITESPACE,
    CUSTOM_ELEMENT$1 = CUSTOM_ELEMENT;
  let IS_ALLOWED_URI$1 = IS_ALLOWED_URI;
  let ALLOWED_TAGS = null;
  const DEFAULT_ALLOWED_TAGS = addToSet({}, [
    ...html$1,
    ...svg$1,
    ...svgFilters,
    ...mathMl$1,
    ...text,
  ]);
  let ALLOWED_ATTR = null;
  const DEFAULT_ALLOWED_ATTR = addToSet({}, [
    ...html,
    ...svg,
    ...mathMl,
    ...xml,
  ]);
  let CUSTOM_ELEMENT_HANDLING = Object.seal(
    create(null, {
      tagNameCheck: {
        writable: true,
        configurable: false,
        enumerable: true,
        value: null,
      },
      attributeNameCheck: {
        writable: true,
        configurable: false,
        enumerable: true,
        value: null,
      },
      allowCustomizedBuiltInElements: {
        writable: true,
        configurable: false,
        enumerable: true,
        value: false,
      },
    }),
  );
  let FORBID_TAGS = null;
  let FORBID_ATTR = null;
  const EXTRA_ELEMENT_HANDLING = Object.seal(
    create(null, {
      tagCheck: {
        writable: true,
        configurable: false,
        enumerable: true,
        value: null,
      },
      attributeCheck: {
        writable: true,
        configurable: false,
        enumerable: true,
        value: null,
      },
    }),
  );
  let ALLOW_ARIA_ATTR = true;
  let ALLOW_DATA_ATTR = true;
  let ALLOW_UNKNOWN_PROTOCOLS = false;
  let ALLOW_SELF_CLOSE_IN_ATTR = true;
  let SAFE_FOR_TEMPLATES = false;
  let SAFE_FOR_XML = true;
  let WHOLE_DOCUMENT = false;
  let SET_CONFIG = false;
  let SET_CONFIG_ALLOWED_TAGS = null;
  let SET_CONFIG_ALLOWED_ATTR = null;
  let FORCE_BODY = false;
  let RETURN_DOM = false;
  let RETURN_DOM_FRAGMENT = false;
  let RETURN_TRUSTED_TYPE = false;
  let SANITIZE_DOM = true;
  let SANITIZE_NAMED_PROPS = false;
  const SANITIZE_NAMED_PROPS_PREFIX = "user-content-";
  let KEEP_CONTENT = true;
  let IN_PLACE = false;
  let USE_PROFILES = {};
  let FORBID_CONTENTS = null;
  const DEFAULT_FORBID_CONTENTS = addToSet({}, [
    "annotation-xml",
    "audio",
    "colgroup",
    "desc",
    "foreignobject",
    "head",
    "iframe",
    "math",
    "mi",
    "mn",
    "mo",
    "ms",
    "mtext",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "script",
    // <selectedcontent> mirrors the selected <option>'s subtree, cloned by
    // the UA (customizable <select>) — including any on* handlers — and the
    // engine re-mirrors synchronously whenever a removal changes which
    // option/selectedcontent is current, even inside DOMPurify's inert
    // DOMParser document. Hoisting its children on removal re-inserts a fresh
    // mirror target ahead of the walk, which the engine refills, looping
    // forever (DoS) and amplifying output. Dropping its content on removal
    // (rather than hoisting) breaks that cascade; the content is a duplicate
    // of the option, which is sanitized on its own. See campaign-3 F1/F6.
    "selectedcontent",
    "style",
    "svg",
    "template",
    "thead",
    "title",
    "video",
    "xmp",
  ]);
  let DATA_URI_TAGS = null;
  const DEFAULT_DATA_URI_TAGS = addToSet({}, [
    "audio",
    "video",
    "img",
    "source",
    "image",
    "track",
  ]);
  let URI_SAFE_ATTRIBUTES = null;
  const DEFAULT_URI_SAFE_ATTRIBUTES = addToSet({}, [
    "alt",
    "class",
    "for",
    "id",
    "label",
    "name",
    "pattern",
    "placeholder",
    "role",
    "summary",
    "title",
    "value",
    "style",
    "xmlns",
  ]);
  const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
  let NAMESPACE = HTML_NAMESPACE;
  let IS_EMPTY_INPUT = false;
  let ALLOWED_NAMESPACES = null;
  const DEFAULT_ALLOWED_NAMESPACES = addToSet(
    {},
    [MATHML_NAMESPACE, SVG_NAMESPACE, HTML_NAMESPACE],
    stringToString,
  );
  const DEFAULT_MATHML_TEXT_INTEGRATION_POINTS = freeze([
    "mi",
    "mo",
    "mn",
    "ms",
    "mtext",
  ]);
  let MATHML_TEXT_INTEGRATION_POINTS = addToSet(
    {},
    DEFAULT_MATHML_TEXT_INTEGRATION_POINTS,
  );
  const DEFAULT_HTML_INTEGRATION_POINTS = freeze(["annotation-xml"]);
  let HTML_INTEGRATION_POINTS = addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS);
  const COMMON_SVG_AND_HTML_ELEMENTS = addToSet({}, [
    "title",
    "style",
    "font",
    "a",
    "script",
  ]);
  let PARSER_MEDIA_TYPE = null;
  const SUPPORTED_PARSER_MEDIA_TYPES = ["application/xhtml+xml", "text/html"];
  const DEFAULT_PARSER_MEDIA_TYPE = "text/html";
  let transformCaseFunc = null;
  let CONFIG = null;
  const formElement = document.createElement("form");
  const isRegexOrFunction = function isRegexOrFunction2(testValue) {
    return testValue instanceof RegExp || testValue instanceof Function;
  };
  const _parseConfig = function _parseConfig2() {
    let cfg =
      arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    if (CONFIG && CONFIG === cfg) {
      return;
    }
    if (!cfg || typeof cfg !== "object") {
      cfg = {};
    }
    cfg = clone(cfg);
    PARSER_MEDIA_TYPE = // eslint-disable-next-line unicorn/prefer-includes
      SUPPORTED_PARSER_MEDIA_TYPES.indexOf(cfg.PARSER_MEDIA_TYPE) === -1
        ? DEFAULT_PARSER_MEDIA_TYPE
        : cfg.PARSER_MEDIA_TYPE;
    transformCaseFunc =
      PARSER_MEDIA_TYPE === "application/xhtml+xml"
        ? stringToString
        : stringToLowerCase;
    ALLOWED_TAGS = _resolveSetOption(
      cfg,
      "ALLOWED_TAGS",
      DEFAULT_ALLOWED_TAGS,
      {
        transform: transformCaseFunc,
      },
    );
    ALLOWED_ATTR = _resolveSetOption(
      cfg,
      "ALLOWED_ATTR",
      DEFAULT_ALLOWED_ATTR,
      {
        transform: transformCaseFunc,
      },
    );
    ALLOWED_NAMESPACES = _resolveSetOption(
      cfg,
      "ALLOWED_NAMESPACES",
      DEFAULT_ALLOWED_NAMESPACES,
      {
        transform: stringToString,
      },
    );
    URI_SAFE_ATTRIBUTES = _resolveSetOption(
      cfg,
      "ADD_URI_SAFE_ATTR",
      DEFAULT_URI_SAFE_ATTRIBUTES,
      {
        transform: transformCaseFunc,
        base: DEFAULT_URI_SAFE_ATTRIBUTES,
      },
    );
    DATA_URI_TAGS = _resolveSetOption(
      cfg,
      "ADD_DATA_URI_TAGS",
      DEFAULT_DATA_URI_TAGS,
      {
        transform: transformCaseFunc,
        base: DEFAULT_DATA_URI_TAGS,
      },
    );
    FORBID_CONTENTS = _resolveSetOption(
      cfg,
      "FORBID_CONTENTS",
      DEFAULT_FORBID_CONTENTS,
      {
        transform: transformCaseFunc,
      },
    );
    FORBID_TAGS = _resolveSetOption(cfg, "FORBID_TAGS", clone({}), {
      transform: transformCaseFunc,
    });
    FORBID_ATTR = _resolveSetOption(cfg, "FORBID_ATTR", clone({}), {
      transform: transformCaseFunc,
    });
    USE_PROFILES = objectHasOwnProperty(cfg, "USE_PROFILES")
      ? cfg.USE_PROFILES && typeof cfg.USE_PROFILES === "object"
        ? clone(cfg.USE_PROFILES)
        : cfg.USE_PROFILES
      : false;
    ALLOW_ARIA_ATTR = cfg.ALLOW_ARIA_ATTR !== false;
    ALLOW_DATA_ATTR = cfg.ALLOW_DATA_ATTR !== false;
    ALLOW_UNKNOWN_PROTOCOLS = cfg.ALLOW_UNKNOWN_PROTOCOLS || false;
    ALLOW_SELF_CLOSE_IN_ATTR = cfg.ALLOW_SELF_CLOSE_IN_ATTR !== false;
    SAFE_FOR_TEMPLATES = cfg.SAFE_FOR_TEMPLATES || false;
    SAFE_FOR_XML = cfg.SAFE_FOR_XML !== false;
    WHOLE_DOCUMENT = cfg.WHOLE_DOCUMENT || false;
    RETURN_DOM = cfg.RETURN_DOM || false;
    RETURN_DOM_FRAGMENT = cfg.RETURN_DOM_FRAGMENT || false;
    RETURN_TRUSTED_TYPE = cfg.RETURN_TRUSTED_TYPE || false;
    FORCE_BODY = cfg.FORCE_BODY || false;
    SANITIZE_DOM = cfg.SANITIZE_DOM !== false;
    SANITIZE_NAMED_PROPS = cfg.SANITIZE_NAMED_PROPS || false;
    KEEP_CONTENT = cfg.KEEP_CONTENT !== false;
    IN_PLACE = cfg.IN_PLACE || false;
    IS_ALLOWED_URI$1 = isRegex(cfg.ALLOWED_URI_REGEXP)
      ? cfg.ALLOWED_URI_REGEXP
      : IS_ALLOWED_URI;
    NAMESPACE =
      typeof cfg.NAMESPACE === "string" ? cfg.NAMESPACE : HTML_NAMESPACE;
    MATHML_TEXT_INTEGRATION_POINTS =
      objectHasOwnProperty(cfg, "MATHML_TEXT_INTEGRATION_POINTS") &&
      cfg.MATHML_TEXT_INTEGRATION_POINTS &&
      typeof cfg.MATHML_TEXT_INTEGRATION_POINTS === "object"
        ? clone(cfg.MATHML_TEXT_INTEGRATION_POINTS)
        : addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS);
    HTML_INTEGRATION_POINTS =
      objectHasOwnProperty(cfg, "HTML_INTEGRATION_POINTS") &&
      cfg.HTML_INTEGRATION_POINTS &&
      typeof cfg.HTML_INTEGRATION_POINTS === "object"
        ? clone(cfg.HTML_INTEGRATION_POINTS)
        : addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS);
    const customElementHandling =
      objectHasOwnProperty(cfg, "CUSTOM_ELEMENT_HANDLING") &&
      cfg.CUSTOM_ELEMENT_HANDLING &&
      typeof cfg.CUSTOM_ELEMENT_HANDLING === "object"
        ? clone(cfg.CUSTOM_ELEMENT_HANDLING)
        : create(null);
    CUSTOM_ELEMENT_HANDLING = create(null);
    if (
      objectHasOwnProperty(customElementHandling, "tagNameCheck") &&
      isRegexOrFunction(customElementHandling.tagNameCheck)
    ) {
      CUSTOM_ELEMENT_HANDLING.tagNameCheck = customElementHandling.tagNameCheck;
    }
    if (
      objectHasOwnProperty(customElementHandling, "attributeNameCheck") &&
      isRegexOrFunction(customElementHandling.attributeNameCheck)
    ) {
      CUSTOM_ELEMENT_HANDLING.attributeNameCheck =
        customElementHandling.attributeNameCheck;
    }
    if (
      objectHasOwnProperty(
        customElementHandling,
        "allowCustomizedBuiltInElements",
      ) &&
      typeof customElementHandling.allowCustomizedBuiltInElements === "boolean"
    ) {
      CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements =
        customElementHandling.allowCustomizedBuiltInElements;
    }
    seal(CUSTOM_ELEMENT_HANDLING);
    if (SAFE_FOR_TEMPLATES) {
      ALLOW_DATA_ATTR = false;
    }
    if (RETURN_DOM_FRAGMENT) {
      RETURN_DOM = true;
    }
    if (USE_PROFILES) {
      ALLOWED_TAGS = addToSet({}, text);
      ALLOWED_ATTR = create(null);
      if (USE_PROFILES.html === true) {
        addToSet(ALLOWED_TAGS, html$1);
        addToSet(ALLOWED_ATTR, html);
      }
      if (USE_PROFILES.svg === true) {
        addToSet(ALLOWED_TAGS, svg$1);
        addToSet(ALLOWED_ATTR, svg);
        addToSet(ALLOWED_ATTR, xml);
      }
      if (USE_PROFILES.svgFilters === true) {
        addToSet(ALLOWED_TAGS, svgFilters);
        addToSet(ALLOWED_ATTR, svg);
        addToSet(ALLOWED_ATTR, xml);
      }
      if (USE_PROFILES.mathMl === true) {
        addToSet(ALLOWED_TAGS, mathMl$1);
        addToSet(ALLOWED_ATTR, mathMl);
        addToSet(ALLOWED_ATTR, xml);
      }
    }
    EXTRA_ELEMENT_HANDLING.tagCheck = null;
    EXTRA_ELEMENT_HANDLING.attributeCheck = null;
    if (objectHasOwnProperty(cfg, "ADD_TAGS")) {
      if (typeof cfg.ADD_TAGS === "function") {
        EXTRA_ELEMENT_HANDLING.tagCheck = cfg.ADD_TAGS;
      } else if (arrayIsArray(cfg.ADD_TAGS)) {
        if (ALLOWED_TAGS === DEFAULT_ALLOWED_TAGS) {
          ALLOWED_TAGS = clone(ALLOWED_TAGS);
        }
        addToSet(ALLOWED_TAGS, cfg.ADD_TAGS, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_ATTR")) {
      if (typeof cfg.ADD_ATTR === "function") {
        EXTRA_ELEMENT_HANDLING.attributeCheck = cfg.ADD_ATTR;
      } else if (arrayIsArray(cfg.ADD_ATTR)) {
        if (ALLOWED_ATTR === DEFAULT_ALLOWED_ATTR) {
          ALLOWED_ATTR = clone(ALLOWED_ATTR);
        }
        addToSet(ALLOWED_ATTR, cfg.ADD_ATTR, transformCaseFunc);
      }
    }
    if (
      objectHasOwnProperty(cfg, "ADD_URI_SAFE_ATTR") &&
      arrayIsArray(cfg.ADD_URI_SAFE_ATTR)
    ) {
      addToSet(URI_SAFE_ATTRIBUTES, cfg.ADD_URI_SAFE_ATTR, transformCaseFunc);
    }
    if (
      objectHasOwnProperty(cfg, "FORBID_CONTENTS") &&
      arrayIsArray(cfg.FORBID_CONTENTS)
    ) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.FORBID_CONTENTS, transformCaseFunc);
    }
    if (
      objectHasOwnProperty(cfg, "ADD_FORBID_CONTENTS") &&
      arrayIsArray(cfg.ADD_FORBID_CONTENTS)
    ) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.ADD_FORBID_CONTENTS, transformCaseFunc);
    }
    if (KEEP_CONTENT) {
      ALLOWED_TAGS["#text"] = true;
    }
    if (WHOLE_DOCUMENT) {
      addToSet(ALLOWED_TAGS, ["html", "head", "body"]);
    }
    if (ALLOWED_TAGS.table) {
      addToSet(ALLOWED_TAGS, ["tbody"]);
      delete FORBID_TAGS.tbody;
    }
    if (cfg.TRUSTED_TYPES_POLICY) {
      if (typeof cfg.TRUSTED_TYPES_POLICY.createHTML !== "function") {
        throw typeErrorCreate(
          'TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.',
        );
      }
      if (typeof cfg.TRUSTED_TYPES_POLICY.createScriptURL !== "function") {
        throw typeErrorCreate(
          'TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.',
        );
      }
      const previousTrustedTypesPolicy = trustedTypesPolicy;
      trustedTypesPolicy = cfg.TRUSTED_TYPES_POLICY;
      try {
        emptyHTML = _createTrustedHTML("");
      } catch (error) {
        trustedTypesPolicy = previousTrustedTypesPolicy;
        throw error;
      }
    } else if (cfg.TRUSTED_TYPES_POLICY === null) {
      trustedTypesPolicy = void 0;
      emptyHTML = "";
    } else {
      if (trustedTypesPolicy === void 0) {
        trustedTypesPolicy = _getDefaultTrustedTypesPolicy();
      }
      if (trustedTypesPolicy && typeof emptyHTML === "string") {
        emptyHTML = _createTrustedHTML("");
      }
    }
    if (freeze) {
      freeze(cfg);
    }
    CONFIG = cfg;
  };
  const ALL_SVG_TAGS = addToSet({}, [
    ...svg$1,
    ...svgFilters,
    ...svgDisallowed,
  ]);
  const ALL_MATHML_TAGS = addToSet({}, [...mathMl$1, ...mathMlDisallowed]);
  const _checkSvgNamespace = function _checkSvgNamespace2(
    tagName,
    parent,
    parentTagName,
  ) {
    if (parent.namespaceURI === HTML_NAMESPACE) {
      return tagName === "svg";
    }
    if (parent.namespaceURI === MATHML_NAMESPACE) {
      return (
        tagName === "svg" &&
        (parentTagName === "annotation-xml" ||
          MATHML_TEXT_INTEGRATION_POINTS[parentTagName])
      );
    }
    return Boolean(ALL_SVG_TAGS[tagName]);
  };
  const _checkMathMlNamespace = function _checkMathMlNamespace2(
    tagName,
    parent,
    parentTagName,
  ) {
    if (parent.namespaceURI === HTML_NAMESPACE) {
      return tagName === "math";
    }
    if (parent.namespaceURI === SVG_NAMESPACE) {
      return tagName === "math" && HTML_INTEGRATION_POINTS[parentTagName];
    }
    return Boolean(ALL_MATHML_TAGS[tagName]);
  };
  const _checkHtmlNamespace = function _checkHtmlNamespace2(
    tagName,
    parent,
    parentTagName,
  ) {
    if (
      parent.namespaceURI === SVG_NAMESPACE &&
      !HTML_INTEGRATION_POINTS[parentTagName]
    ) {
      return false;
    }
    if (
      parent.namespaceURI === MATHML_NAMESPACE &&
      !MATHML_TEXT_INTEGRATION_POINTS[parentTagName]
    ) {
      return false;
    }
    return (
      !ALL_MATHML_TAGS[tagName] &&
      (COMMON_SVG_AND_HTML_ELEMENTS[tagName] || !ALL_SVG_TAGS[tagName])
    );
  };
  const _checkValidNamespace = function _checkValidNamespace2(element) {
    let parent = getParentNode(element);
    if (!parent || !parent.tagName) {
      parent = {
        namespaceURI: NAMESPACE,
        tagName: "template",
      };
    }
    const tagName = stringToLowerCase(element.tagName);
    const parentTagName = stringToLowerCase(parent.tagName);
    if (!ALLOWED_NAMESPACES[element.namespaceURI]) {
      return false;
    }
    if (element.namespaceURI === SVG_NAMESPACE) {
      return _checkSvgNamespace(tagName, parent, parentTagName);
    }
    if (element.namespaceURI === MATHML_NAMESPACE) {
      return _checkMathMlNamespace(tagName, parent, parentTagName);
    }
    if (element.namespaceURI === HTML_NAMESPACE) {
      return _checkHtmlNamespace(tagName, parent, parentTagName);
    }
    if (
      PARSER_MEDIA_TYPE === "application/xhtml+xml" &&
      ALLOWED_NAMESPACES[element.namespaceURI]
    ) {
      return true;
    }
    return false;
  };
  const _forceRemove = function _forceRemove2(node) {
    arrayPush(DOMPurify.removed, {
      element: node,
    });
    try {
      getParentNode(node).removeChild(node);
    } catch (_2) {
      remove(node);
      if (!getParentNode(node)) {
        throw typeErrorCreate(
          "a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place",
        );
      }
    }
  };
  const _neutralizeRoot = function _neutralizeRoot2(root) {
    _neutralizeSubtree(root);
    const childNodes = getChildNodes(root);
    if (childNodes) {
      const snapshot = [];
      arrayForEach(childNodes, (child) => {
        arrayPush(snapshot, child);
      });
      arrayForEach(snapshot, (child) => {
        try {
          remove(child);
        } catch (_2) {}
      });
    }
    const attributes = getAttributes(root);
    if (attributes) {
      for (let i = attributes.length - 1; i >= 0; --i) {
        const attribute = attributes[i];
        const name = attribute && attribute.name;
        if (typeof name === "string") {
          try {
            root.removeAttribute(name);
          } catch (_2) {}
        }
      }
    }
  };
  const _removeAttribute = function _removeAttribute2(name, element) {
    try {
      arrayPush(DOMPurify.removed, {
        attribute: element.getAttributeNode(name),
        from: element,
      });
    } catch (_2) {
      arrayPush(DOMPurify.removed, {
        attribute: null,
        from: element,
      });
    }
    element.removeAttribute(name);
    if (name === "is") {
      if (RETURN_DOM || RETURN_DOM_FRAGMENT) {
        try {
          _forceRemove(element);
        } catch (_2) {}
      } else {
        try {
          element.setAttribute(name, "");
        } catch (_2) {}
      }
    }
  };
  const _stripDisallowedAttributes = function _stripDisallowedAttributes2(
    element,
  ) {
    const attributes = getAttributes(element);
    if (!attributes) {
      return;
    }
    for (let i = attributes.length - 1; i >= 0; --i) {
      const attribute = attributes[i];
      const name = attribute && attribute.name;
      if (typeof name !== "string" || ALLOWED_ATTR[transformCaseFunc(name)]) {
        continue;
      }
      try {
        element.removeAttribute(name);
      } catch (_2) {}
    }
  };
  const _neutralizeSubtree = function _neutralizeSubtree2(root) {
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      const nodeType = getNodeType ? getNodeType(node) : node.nodeType;
      if (nodeType === NODE_TYPE.element) {
        _stripDisallowedAttributes(node);
      }
      const childNodes = getChildNodes(node);
      if (childNodes) {
        for (let i = childNodes.length - 1; i >= 0; --i) {
          stack.push(childNodes[i]);
        }
      }
    }
  };
  const _neutralizePatchLinkage = function _neutralizePatchLinkage2(root) {
    if (!SAFE_FOR_XML) {
      return;
    }
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      const nodeType = getNodeType ? getNodeType(node) : node.nodeType;
      if (
        nodeType === NODE_TYPE.processingInstruction ||
        (nodeType === NODE_TYPE.comment &&
          regExpTest(COMMENT_MARKUP_PROBE, node.data))
      ) {
        try {
          remove(node);
        } catch (_2) {}
        continue;
      }
      if (nodeType === NODE_TYPE.element) {
        const element = node;
        const lcTag = transformCaseFunc(
          getNodeName ? getNodeName(node) : node.nodeName,
        );
        try {
          if (element.hasAttribute && element.hasAttribute("patchsrc")) {
            element.removeAttribute("patchsrc");
          }
          if (
            element.hasAttribute &&
            element.hasAttribute("for") &&
            lcTag !== "label" &&
            lcTag !== "output"
          ) {
            element.removeAttribute("for");
          }
        } catch (_2) {}
      }
      const childNodes = getChildNodes(node);
      if (childNodes) {
        for (let i = childNodes.length - 1; i >= 0; --i) {
          stack.push(childNodes[i]);
        }
      }
    }
  };
  const _initDocument = function _initDocument2(dirty) {
    let doc = null;
    let leadingWhitespace = null;
    if (FORCE_BODY) {
      dirty = "<remove></remove>" + dirty;
    } else {
      const matches = stringMatch(dirty, /^[\r\n\t ]+/);
      leadingWhitespace = matches && matches[0];
    }
    if (
      PARSER_MEDIA_TYPE === "application/xhtml+xml" &&
      NAMESPACE === HTML_NAMESPACE
    ) {
      dirty =
        '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' +
        dirty +
        "</body></html>";
    }
    const dirtyPayload = trustedTypesPolicy ? _createTrustedHTML(dirty) : dirty;
    if (NAMESPACE === HTML_NAMESPACE) {
      try {
        doc = new DOMParser().parseFromString(dirtyPayload, PARSER_MEDIA_TYPE);
      } catch (_2) {}
    }
    if (!doc || !doc.documentElement) {
      doc = implementation.createDocument(NAMESPACE, "template", null);
      try {
        doc.documentElement.innerHTML = IS_EMPTY_INPUT
          ? emptyHTML
          : dirtyPayload;
      } catch (_2) {}
    }
    const body = doc.body || doc.documentElement;
    if (dirty && leadingWhitespace) {
      body.insertBefore(
        document.createTextNode(leadingWhitespace),
        body.childNodes[0] || null,
      );
    }
    if (NAMESPACE === HTML_NAMESPACE) {
      return getElementsByTagName.call(
        doc,
        WHOLE_DOCUMENT ? "html" : "body",
      )[0];
    }
    return WHOLE_DOCUMENT ? doc.documentElement : body;
  };
  const _createNodeIterator = function _createNodeIterator2(root) {
    return createNodeIterator.call(
      root.ownerDocument || root,
      root,
      // eslint-disable-next-line no-bitwise
      NodeFilter.SHOW_ELEMENT |
        NodeFilter.SHOW_COMMENT |
        NodeFilter.SHOW_TEXT |
        NodeFilter.SHOW_PROCESSING_INSTRUCTION |
        NodeFilter.SHOW_CDATA_SECTION,
      null,
    );
  };
  const _stripTemplateExpressions = function _stripTemplateExpressions2(value) {
    value = stringReplace(value, MUSTACHE_EXPR$1, " ");
    value = stringReplace(value, ERB_EXPR$1, " ");
    value = stringReplace(value, TMPLIT_EXPR$1, " ");
    return value;
  };
  const _scrubTemplateExpressions2 = function _scrubTemplateExpressions(node) {
    var _node$querySelectorAl;
    node.normalize();
    const walker = createNodeIterator.call(
      node.ownerDocument || node,
      node,
      // eslint-disable-next-line no-bitwise
      NodeFilter.SHOW_TEXT |
        NodeFilter.SHOW_COMMENT |
        NodeFilter.SHOW_CDATA_SECTION |
        NodeFilter.SHOW_PROCESSING_INSTRUCTION,
      null,
    );
    let currentNode = walker.nextNode();
    while (currentNode) {
      currentNode.data = _stripTemplateExpressions(currentNode.data);
      currentNode = walker.nextNode();
    }
    const templates =
      (_node$querySelectorAl = node.querySelectorAll) === null ||
      _node$querySelectorAl === void 0
        ? void 0
        : _node$querySelectorAl.call(node, "template");
    if (templates) {
      arrayForEach(templates, (tmpl) => {
        if (_isDocumentFragment(tmpl.content)) {
          _scrubTemplateExpressions2(tmpl.content);
        }
      });
    }
  };
  const _isClobbered = function _isClobbered2(element) {
    const realTagName = getNodeName ? getNodeName(element) : null;
    if (typeof realTagName !== "string") {
      return false;
    }
    if (transformCaseFunc(realTagName) !== "form") {
      return false;
    }
    return (
      typeof element.nodeName !== "string" ||
      typeof element.textContent !== "string" ||
      typeof element.removeChild !== "function" || // Realm-safe NamedNodeMap detection: equality against the cached
      // prototype getter. Clobbered .attributes (e.g. <input name="attributes">)
      // makes the direct read diverge from the cached read; a clean form
      // (same-realm OR foreign-realm) has both reads pointing at the same
      // canonical NamedNodeMap.
      element.attributes !== getAttributes(element) ||
      typeof element.removeAttribute !== "function" ||
      typeof element.setAttribute !== "function" ||
      typeof element.namespaceURI !== "string" ||
      typeof element.insertBefore !== "function" ||
      typeof element.hasChildNodes !== "function" || // NodeType clobbering probe. Cached Node.prototype.nodeType getter
      // returns the integer 1 for any Element regardless of realm; direct
      // read on a clobbered form (e.g. <input name="nodeType">) returns
      // the named child element. Cheap addition — nodeType is read from
      // an internal slot, no serialization cost — and removes a residual
      // clobbering surface used by several mXSS / PI / comment branches
      // in _sanitizeElements that compare currentNode.nodeType directly.
      element.nodeType !== getNodeType(element) || // HTMLFormElement has [LegacyOverrideBuiltIns]: a descendant named
      // "childNodes" shadows the prototype getter. Direct reads of
      // form.childNodes from a clobbered form return the named child
      // instead of the real NodeList, so any walk that reads it directly
      // skips the form's real children. Compare the direct read to the
      // cached Node.prototype getter — when the form's named-property
      // getter intercepts the read, the two values differ and we flag
      // the form. This catches every clobbering child type (input,
      // select, etc.) regardless of whether the named child happens to
      // carry a numeric .length, which a typeof-based probe would miss
      // (e.g. HTMLSelectElement.length is a defined unsigned-long).
      element.childNodes !== getChildNodes(element)
    );
  };
  const _isDocumentFragment = function _isDocumentFragment2(value) {
    if (!getNodeType || typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return getNodeType(value) === NODE_TYPE.documentFragment;
    } catch (_2) {
      return false;
    }
  };
  const _isNode = function _isNode2(value) {
    if (!getNodeType || typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return typeof getNodeType(value) === "number";
    } catch (_2) {
      return false;
    }
  };
  function _executeHooks(hooks2, currentNode, data) {
    if (hooks2.length === 0) {
      return;
    }
    arrayForEach(hooks2, (hook) => {
      hook.call(DOMPurify, currentNode, data, CONFIG);
    });
  }
  const _isUnsafeNode = function _isUnsafeNode2(currentNode, tagName) {
    if (
      SAFE_FOR_XML &&
      currentNode.hasChildNodes() &&
      !_isNode(currentNode.firstElementChild) &&
      regExpTest(ELEMENT_MARKUP_PROBE, currentNode.textContent) &&
      regExpTest(ELEMENT_MARKUP_PROBE, currentNode.innerHTML)
    ) {
      return true;
    }
    if (
      SAFE_FOR_XML &&
      currentNode.namespaceURI === HTML_NAMESPACE &&
      tagName === "style" &&
      _isNode(currentNode.firstElementChild)
    ) {
      return true;
    }
    if (currentNode.nodeType === NODE_TYPE.processingInstruction) {
      return true;
    }
    if (
      SAFE_FOR_XML &&
      currentNode.nodeType === NODE_TYPE.comment &&
      regExpTest(COMMENT_MARKUP_PROBE, currentNode.data)
    ) {
      return true;
    }
    return false;
  };
  const _sanitizeDisallowedNode = function _sanitizeDisallowedNode2(
    currentNode,
    tagName,
  ) {
    if (!FORBID_TAGS[tagName] && _isBasicCustomElement(tagName)) {
      if (
        CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp &&
        regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, tagName)
      ) {
        return false;
      }
      if (
        CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function &&
        CUSTOM_ELEMENT_HANDLING.tagNameCheck(tagName)
      ) {
        return false;
      }
    }
    if (KEEP_CONTENT && !FORBID_CONTENTS[tagName]) {
      const parentNode = getParentNode(currentNode);
      const childNodes = getChildNodes(currentNode);
      if (childNodes && parentNode) {
        const childCount = childNodes.length;
        for (let i = childCount - 1; i >= 0; --i) {
          const hoisted = IN_PLACE
            ? childNodes[i]
            : cloneNode(childNodes[i], true);
          parentNode.insertBefore(hoisted, getNextSibling(currentNode));
        }
      }
    }
    _forceRemove(currentNode);
    return true;
  };
  const _sanitizeElements = function _sanitizeElements2(currentNode, root) {
    _executeHooks(hooks.beforeSanitizeElements, currentNode, null);
    if (currentNode !== root && getParentNode(currentNode) === null) {
      return true;
    }
    if (_isClobbered(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    const tagName = transformCaseFunc(
      getNodeName ? getNodeName(currentNode) : currentNode.nodeName,
    );
    _executeHooks(hooks.uponSanitizeElement, currentNode, {
      tagName,
      allowedTags: ALLOWED_TAGS,
    });
    if (currentNode !== root && getParentNode(currentNode) === null) {
      return true;
    }
    if (_isUnsafeNode(currentNode, tagName)) {
      _forceRemove(currentNode);
      return true;
    }
    if (
      FORBID_TAGS[tagName] ||
      (!(
        EXTRA_ELEMENT_HANDLING.tagCheck instanceof Function &&
        EXTRA_ELEMENT_HANDLING.tagCheck(tagName)
      ) &&
        !ALLOWED_TAGS[tagName])
    ) {
      const removed = _sanitizeDisallowedNode(currentNode, tagName);
      if (removed === false) {
        _executeHooks(hooks.afterSanitizeElements, currentNode, null);
      }
      return removed;
    }
    const nt2 = getNodeType ? getNodeType(currentNode) : currentNode.nodeType;
    if (nt2 === NODE_TYPE.element && !_checkValidNamespace(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    if (
      (tagName === "noscript" ||
        tagName === "noembed" ||
        tagName === "noframes") &&
      regExpTest(FALLBACK_TAG_CLOSE, currentNode.innerHTML)
    ) {
      _forceRemove(currentNode);
      return true;
    }
    if (SAFE_FOR_TEMPLATES && currentNode.nodeType === NODE_TYPE.text) {
      const content = _stripTemplateExpressions(currentNode.textContent);
      if (currentNode.textContent !== content) {
        arrayPush(DOMPurify.removed, {
          element: currentNode.cloneNode(),
        });
        currentNode.textContent = content;
      }
    }
    _executeHooks(hooks.afterSanitizeElements, currentNode, null);
    return false;
  };
  const _isValidAttribute = function _isValidAttribute2(lcTag, lcName, value) {
    if (FORBID_ATTR[lcName]) {
      return false;
    }
    if (SAFE_FOR_XML && lcName === "patchsrc") {
      return false;
    }
    if (
      SAFE_FOR_XML &&
      lcName === "for" &&
      lcTag !== "label" &&
      lcTag !== "output"
    ) {
      return false;
    }
    if (
      SANITIZE_DOM &&
      (lcName === "id" || lcName === "name") &&
      (value in document || value in formElement)
    ) {
      return false;
    }
    const nameIsPermitted =
      ALLOWED_ATTR[lcName] ||
      (EXTRA_ELEMENT_HANDLING.attributeCheck instanceof Function &&
        EXTRA_ELEMENT_HANDLING.attributeCheck(lcName, lcTag));
    if (ALLOW_DATA_ATTR && regExpTest(DATA_ATTR$1, lcName));
    else if (ALLOW_ARIA_ATTR && regExpTest(ARIA_ATTR$1, lcName));
    else if (!nameIsPermitted) {
      if (
        // First condition does a very basic check if a) it's basically a valid custom element tagname AND
        // b) if the tagName passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
        // and c) if the attribute name passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.attributeNameCheck
        (_isBasicCustomElement(lcTag) &&
          ((CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp &&
            regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, lcTag)) ||
            (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function &&
              CUSTOM_ELEMENT_HANDLING.tagNameCheck(lcTag))) &&
          ((CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof RegExp &&
            regExpTest(CUSTOM_ELEMENT_HANDLING.attributeNameCheck, lcName)) ||
            (CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof Function &&
              CUSTOM_ELEMENT_HANDLING.attributeNameCheck(lcName, lcTag)))) || // Alternative, second condition checks if it's an `is`-attribute, AND
        // the value passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
        (lcName === "is" &&
          CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements &&
          ((CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp &&
            regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, value)) ||
            (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function &&
              CUSTOM_ELEMENT_HANDLING.tagNameCheck(value))))
      );
      else {
        return false;
      }
    } else if (URI_SAFE_ATTRIBUTES[lcName]);
    else if (
      regExpTest(IS_ALLOWED_URI$1, stringReplace(value, ATTR_WHITESPACE$1, ""))
    );
    else if (
      (lcName === "src" || lcName === "xlink:href" || lcName === "href") &&
      lcTag !== "script" &&
      stringIndexOf(value, "data:") === 0 &&
      DATA_URI_TAGS[lcTag]
    );
    else if (
      ALLOW_UNKNOWN_PROTOCOLS &&
      !regExpTest(
        IS_SCRIPT_OR_DATA$1,
        stringReplace(value, ATTR_WHITESPACE$1, ""),
      )
    );
    else if (value) {
      return false;
    } else;
    return true;
  };
  const RESERVED_CUSTOM_ELEMENT_NAMES = addToSet({}, [
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-format",
    "font-face-name",
    "font-face-src",
    "font-face-uri",
    "missing-glyph",
  ]);
  const _isBasicCustomElement = function _isBasicCustomElement2(tagName) {
    return (
      !RESERVED_CUSTOM_ELEMENT_NAMES[stringToLowerCase(tagName)] &&
      regExpTest(CUSTOM_ELEMENT$1, tagName)
    );
  };
  const _applyTrustedTypesToAttribute = function _applyTrustedTypesToAttribute2(
    lcTag,
    lcName,
    namespaceURI,
    value,
  ) {
    if (
      trustedTypesPolicy &&
      typeof trustedTypes === "object" &&
      typeof trustedTypes.getAttributeType === "function" &&
      !namespaceURI
    ) {
      switch (trustedTypes.getAttributeType(lcTag, lcName)) {
        case "TrustedHTML": {
          return _createTrustedHTML(value);
        }
        case "TrustedScriptURL": {
          return _createTrustedScriptURL(value);
        }
      }
    }
    return value;
  };
  const _setAttributeValue = function _setAttributeValue2(
    currentNode,
    name,
    namespaceURI,
    value,
  ) {
    try {
      if (namespaceURI) {
        currentNode.setAttributeNS(namespaceURI, name, value);
      } else {
        currentNode.setAttribute(name, value);
      }
      if (_isClobbered(currentNode)) {
        _forceRemove(currentNode);
      } else {
        arrayPop(DOMPurify.removed);
      }
    } catch (_2) {
      _removeAttribute(name, currentNode);
    }
  };
  const _sanitizeAttributes = function _sanitizeAttributes2(currentNode) {
    _executeHooks(hooks.beforeSanitizeAttributes, currentNode, null);
    const attributes = currentNode.attributes;
    if (!attributes || _isClobbered(currentNode)) {
      return;
    }
    const hookEvent = {
      attrName: "",
      attrValue: "",
      keepAttr: true,
      allowedAttributes: ALLOWED_ATTR,
      forceKeepAttr: void 0,
    };
    let l3 = attributes.length;
    const lcTag = transformCaseFunc(currentNode.nodeName);
    while (l3--) {
      const attr = attributes[l3];
      const name = attr.name,
        namespaceURI = attr.namespaceURI,
        attrValue = attr.value;
      const lcName = transformCaseFunc(name);
      const initValue = attrValue;
      let value = name === "value" ? initValue : stringTrim(initValue);
      hookEvent.attrName = lcName;
      hookEvent.attrValue = value;
      hookEvent.keepAttr = true;
      hookEvent.forceKeepAttr = void 0;
      _executeHooks(hooks.uponSanitizeAttribute, currentNode, hookEvent);
      value = hookEvent.attrValue;
      if (
        SANITIZE_NAMED_PROPS &&
        (lcName === "id" || lcName === "name") &&
        stringIndexOf(value, SANITIZE_NAMED_PROPS_PREFIX) !== 0
      ) {
        _removeAttribute(name, currentNode);
        value = SANITIZE_NAMED_PROPS_PREFIX + value;
      }
      if (
        SAFE_FOR_XML &&
        regExpTest(
          /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i,
          value,
        )
      ) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (lcName === "attributename" && stringMatch(value, "href")) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (hookEvent.forceKeepAttr) {
        continue;
      }
      if (!hookEvent.keepAttr) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (!ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(SELF_CLOSING_TAG, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (SAFE_FOR_TEMPLATES) {
        value = _stripTemplateExpressions(value);
      }
      if (!_isValidAttribute(lcTag, lcName, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      value = _applyTrustedTypesToAttribute(lcTag, lcName, namespaceURI, value);
      if (value !== initValue) {
        _setAttributeValue(currentNode, name, namespaceURI, value);
      }
    }
    _executeHooks(hooks.afterSanitizeAttributes, currentNode, null);
  };
  const _sanitizeShadowDOM2 = function _sanitizeShadowDOM(fragment) {
    let shadowNode = null;
    const shadowIterator = _createNodeIterator(fragment);
    _executeHooks(hooks.beforeSanitizeShadowDOM, fragment, null);
    while ((shadowNode = shadowIterator.nextNode())) {
      _executeHooks(hooks.uponSanitizeShadowNode, shadowNode, null);
      _sanitizeElements(shadowNode, fragment);
      _sanitizeAttributes(shadowNode);
      if (_isDocumentFragment(shadowNode.content)) {
        _sanitizeShadowDOM2(shadowNode.content);
      }
      const shadowNodeType = getNodeType
        ? getNodeType(shadowNode)
        : shadowNode.nodeType;
      if (shadowNodeType === NODE_TYPE.element) {
        const innerSr = getShadowRoot(shadowNode);
        if (_isDocumentFragment(innerSr)) {
          _sanitizeAttachedShadowRoots(innerSr);
          _sanitizeShadowDOM2(innerSr);
        }
      }
    }
    _executeHooks(hooks.afterSanitizeShadowDOM, fragment, null);
  };
  const _sanitizeAttachedShadowRoots = function _sanitizeAttachedShadowRoots2(
    root,
  ) {
    const stack = [
      {
        node: root,
        shadow: null,
      },
    ];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item.shadow) {
        _sanitizeShadowDOM2(item.shadow);
        continue;
      }
      const node = item.node;
      const nodeType = getNodeType ? getNodeType(node) : node.nodeType;
      const isElement = nodeType === NODE_TYPE.element;
      const childNodes = getChildNodes(node);
      if (childNodes) {
        for (let i = childNodes.length - 1; i >= 0; --i) {
          stack.push({
            node: childNodes[i],
            shadow: null,
          });
        }
      }
      if (isElement) {
        const rootName = getNodeName ? getNodeName(node) : null;
        if (
          typeof rootName === "string" &&
          transformCaseFunc(rootName) === "template"
        ) {
          const content = node.content;
          if (_isDocumentFragment(content)) {
            stack.push({
              node: content,
              shadow: null,
            });
          }
        }
      }
      if (isElement) {
        const sr = getShadowRoot(node);
        if (_isDocumentFragment(sr)) {
          stack.push(
            {
              node: null,
              shadow: sr,
            },
            {
              node: sr,
              shadow: null,
            },
          );
        }
      }
    }
  };
  DOMPurify.sanitize = function (dirty) {
    let cfg =
      arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
    let body = null;
    let importedNode = null;
    let currentNode = null;
    let returnNode = null;
    IS_EMPTY_INPUT = !dirty;
    if (IS_EMPTY_INPUT) {
      dirty = "<!-->";
    }
    if (typeof dirty !== "string" && !_isNode(dirty)) {
      dirty = stringifyValue(dirty);
      if (typeof dirty !== "string") {
        throw typeErrorCreate("dirty is not a string, aborting");
      }
    }
    if (!DOMPurify.isSupported) {
      return dirty;
    }
    if (SET_CONFIG) {
      ALLOWED_TAGS = SET_CONFIG_ALLOWED_TAGS;
      ALLOWED_ATTR = SET_CONFIG_ALLOWED_ATTR;
    } else {
      _parseConfig(cfg);
    }
    if (
      hooks.uponSanitizeElement.length > 0 ||
      hooks.uponSanitizeAttribute.length > 0
    ) {
      ALLOWED_TAGS = clone(ALLOWED_TAGS);
    }
    if (hooks.uponSanitizeAttribute.length > 0) {
      ALLOWED_ATTR = clone(ALLOWED_ATTR);
    }
    DOMPurify.removed = [];
    const inPlace = IN_PLACE && typeof dirty !== "string" && _isNode(dirty);
    if (inPlace) {
      _neutralizePatchLinkage(dirty);
      const nn = getNodeName ? getNodeName(dirty) : dirty.nodeName;
      if (typeof nn === "string") {
        const tagName = transformCaseFunc(nn);
        if (!ALLOWED_TAGS[tagName] || FORBID_TAGS[tagName]) {
          _neutralizeRoot(dirty);
          throw typeErrorCreate(
            "root node is forbidden and cannot be sanitized in-place",
          );
        }
      }
      if (_isClobbered(dirty)) {
        _neutralizeRoot(dirty);
        throw typeErrorCreate(
          "root node is clobbered and cannot be sanitized in-place",
        );
      }
      try {
        _sanitizeAttachedShadowRoots(dirty);
      } catch (error) {
        _neutralizeRoot(dirty);
        throw error;
      }
    } else if (_isNode(dirty)) {
      body = _initDocument("<!---->");
      importedNode = body.ownerDocument.importNode(dirty, true);
      if (
        importedNode.nodeType === NODE_TYPE.element &&
        importedNode.nodeName === "BODY"
      ) {
        body = importedNode;
      } else if (importedNode.nodeName === "HTML") {
        body = importedNode;
      } else {
        body.appendChild(importedNode);
      }
      _sanitizeAttachedShadowRoots(importedNode);
    } else {
      if (
        !RETURN_DOM &&
        !SAFE_FOR_TEMPLATES &&
        !WHOLE_DOCUMENT && // eslint-disable-next-line unicorn/prefer-includes
        dirty.indexOf("<") === -1
      ) {
        return trustedTypesPolicy && RETURN_TRUSTED_TYPE
          ? _createTrustedHTML(dirty)
          : dirty;
      }
      body = _initDocument(dirty);
      if (!body) {
        return RETURN_DOM ? null : RETURN_TRUSTED_TYPE ? emptyHTML : "";
      }
    }
    if (body && FORCE_BODY) {
      _forceRemove(body.firstChild);
    }
    const walkRoot = inPlace ? dirty : body;
    const nodeIterator = _createNodeIterator(walkRoot);
    try {
      while ((currentNode = nodeIterator.nextNode())) {
        _sanitizeElements(currentNode, walkRoot);
        _sanitizeAttributes(currentNode);
        if (_isDocumentFragment(currentNode.content)) {
          _sanitizeShadowDOM2(currentNode.content);
        }
      }
    } catch (error) {
      if (inPlace) {
        _neutralizeRoot(dirty);
        arrayForEach(DOMPurify.removed, (entry) => {
          if (entry.element) {
            _neutralizeSubtree(entry.element);
          }
        });
      }
      throw error;
    }
    if (inPlace) {
      arrayForEach(DOMPurify.removed, (entry) => {
        if (entry.element) {
          _neutralizeSubtree(entry.element);
        }
      });
      if (SAFE_FOR_TEMPLATES) {
        _scrubTemplateExpressions2(dirty);
      }
      return dirty;
    }
    if (RETURN_DOM) {
      if (SAFE_FOR_TEMPLATES) {
        _scrubTemplateExpressions2(body);
      }
      if (RETURN_DOM_FRAGMENT) {
        returnNode = createDocumentFragment.call(body.ownerDocument);
        while (body.firstChild) {
          returnNode.appendChild(body.firstChild);
        }
      } else {
        returnNode = body;
      }
      if (ALLOWED_ATTR.shadowroot || ALLOWED_ATTR.shadowrootmode) {
        returnNode = importNode.call(originalDocument, returnNode, true);
      }
      return returnNode;
    }
    let serializedHTML = WHOLE_DOCUMENT ? body.outerHTML : body.innerHTML;
    if (
      WHOLE_DOCUMENT &&
      ALLOWED_TAGS["!doctype"] &&
      body.ownerDocument &&
      body.ownerDocument.doctype &&
      body.ownerDocument.doctype.name &&
      regExpTest(DOCTYPE_NAME, body.ownerDocument.doctype.name)
    ) {
      serializedHTML =
        "<!DOCTYPE " + body.ownerDocument.doctype.name + ">\n" + serializedHTML;
    }
    if (SAFE_FOR_TEMPLATES) {
      serializedHTML = _stripTemplateExpressions(serializedHTML);
    }
    return trustedTypesPolicy && RETURN_TRUSTED_TYPE
      ? _createTrustedHTML(serializedHTML)
      : serializedHTML;
  };
  DOMPurify.setConfig = function () {
    let cfg =
      arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    _parseConfig(cfg);
    SET_CONFIG = true;
    SET_CONFIG_ALLOWED_TAGS = ALLOWED_TAGS;
    SET_CONFIG_ALLOWED_ATTR = ALLOWED_ATTR;
  };
  DOMPurify.clearConfig = function () {
    CONFIG = null;
    SET_CONFIG = false;
    SET_CONFIG_ALLOWED_TAGS = null;
    SET_CONFIG_ALLOWED_ATTR = null;
    trustedTypesPolicy = defaultTrustedTypesPolicy;
    emptyHTML = "";
  };
  DOMPurify.isValidAttribute = function (tag, attr, value) {
    if (!CONFIG) {
      _parseConfig({});
    }
    const lcTag = transformCaseFunc(tag);
    const lcName = transformCaseFunc(attr);
    return _isValidAttribute(lcTag, lcName, value);
  };
  DOMPurify.addHook = function (entryPoint, hookFunction) {
    if (typeof hookFunction !== "function") {
      return;
    }
    if (!objectHasOwnProperty(hooks, entryPoint)) {
      return;
    }
    arrayPush(hooks[entryPoint], hookFunction);
  };
  DOMPurify.removeHook = function (entryPoint, hookFunction) {
    if (!objectHasOwnProperty(hooks, entryPoint)) {
      return void 0;
    }
    if (hookFunction !== void 0) {
      const index = arrayLastIndexOf(hooks[entryPoint], hookFunction);
      return index === -1
        ? void 0
        : arraySplice(hooks[entryPoint], index, 1)[0];
    }
    return arrayPop(hooks[entryPoint]);
  };
  DOMPurify.removeHooks = function (entryPoint) {
    if (!objectHasOwnProperty(hooks, entryPoint)) {
      return;
    }
    hooks[entryPoint] = [];
  };
  DOMPurify.removeAllHooks = function () {
    hooks = _createHooksMap();
  };
  return DOMPurify;
}
var purify = createDOMPurify();

// web/scripts/vendor/markdown-entry.js
g.setOptions({ gfm: true, breaks: false });
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
function renderMarkdown(src) {
  const rawHtml = g.parse(src ?? "", { async: false });
  return purify.sanitize(rawHtml);
}
var markdown_entry_default = renderMarkdown;
export { markdown_entry_default as default, renderMarkdown };
/*! Bundled license information:

dompurify/dist/purify.es.mjs:
  (*! @license DOMPurify 3.4.12 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.12/LICENSE *)
*/
