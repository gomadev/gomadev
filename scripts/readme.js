import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// RSS

async function fetchRSS(url, sourceName, limit = 8) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "readme-news-bot" } });
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);

    return items.map((match) => {
      const block = match[1];
      const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || "";
      const link  = block.match(/<link>(.*?)<\/link>|<guid>(https?[^<]+)<\/guid>/)?.[1] || "";
      return {
        title: title.trim(),
        url:   link.trim(),
        points: 0,
        source: sourceName,
      };
    }).filter((i) => i.title && i.url);
  } catch (e) {
    console.error(`Erro ao buscar RSS ${sourceName}:`, e.message);
    return [];
  }
}

// Fontes

const FONTES = [
  { url: "https://tecnoblog.net/feed/",              nome: "Tecnoblog"  },
  { url: "https://canaltech.com.br/rss/",            nome: "Canaltech"  },
  { url: "https://imasters.com.br/feed",             nome: "iMasters"   },
  { url: "https://www.tecmundo.com.br/rss",          nome: "TecMundo"   },
];

// Etapa 2 ─ Groq

async function generateContent(allNews) {
  const today = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const newsText = allNews
    .map((n, i) => `${i + 1}. [${n.source}] ${n.title} (${n.points} pts)\n   URL: ${n.url}`)
    .join("\n");

  const prompt = `Você é um curador de notícias tech. Hoje é ${today}.

Notícias disponíveis:
${newsText}

Retorne APENAS um JSON válido, sem explicações, sem markdown, sem blocos de código. Estrutura exata:

{
  "frase_do_dia": "uma frase curta (máx 10 palavras), ousada, sobre tecnologia ou o dia. sem saudações.",
  "noticias": [
    {
      "index": 1,
      "emoji": "emoji temático",
      "impacto": "por que importa em até 5 palavras"
    }
  ],
  "destaque": "2 frases analíticas sobre o tema mais quente do dia. tom de especialista."
}

Selecione no máximo 8 notícias priorizando relevância para Backend, Data Engineering e IA.
Os índices em "noticias" devem corresponder aos números da lista acima.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1000,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.choices[0].message.content.trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Tenta extrair JSON caso venha com texto ao redor
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Resposta do Groq não é JSON válido:\n" + raw);
  }
}

// Montagem

function sourceLabel(source) {
  return source.toLowerCase();
}

function buildReadme(template, allNews, content) {
  const rows = content.noticias.map((item) => {
    const news = allNews[item.index - 1];
    if (!news) return null;
    return `<img src="arrows.png" width="14"/> [${news.title}](${news.url}) — ${item.impacto} \`${sourceLabel(news.source)}\``;
  }).filter(Boolean);

  const table = rows.join("\n\n");

  return template
    .replace("{{FRASE_DO_DIA}}", content.frase_do_dia)
    .replace("{{TABELA_NOTICIAS}}", table)
    .replace("{{DESTAQUE}}", content.destaque);
}

// Main

async function main() {
  console.log("1. Coleta");

  const results = await Promise.all(
    FONTES.map((f) => fetchRSS(f.url, f.nome))
  );

  const allNews = results.flat();
  console.log(`Ok. ${allNews.length} Coletas`);

  if (allNews.length === 0) {
    console.error("❌ Nenhuma notícia coletada. Abortando.");
    process.exit(1);
  }

  console.log("2. Groq");
  const content = await generateContent(allNews);

  const templatePath = path.join(__dirname, "..", "template.md");
  const template = fs.readFileSync(templatePath, "utf-8");

  const readme = buildReadme(template, allNews, content);

  const readmePath = path.join(__dirname, "..", "README.md");
  fs.writeFileSync(readmePath, readme, "utf-8");

  //console.log("Atualizado!");
  //console.log(`Salvo.`);
  //console.log(`Salvo em: ${readmePath}`);
}

main().catch((e) => {
  console.error("❌ Erro fatal:", e);
  process.exit(1);
});