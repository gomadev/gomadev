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

Responda SEMPRE em português, nunca em inglês.

Notícias disponíveis:
${newsText}

Retorne APENAS um JSON válido, sem explicações, sem markdown, sem blocos de código. Estrutura exata:

{
  "noticias": [
    {
      "index": 1,
      "impacto": "por que importa em até 5 palavras, em português"
    }
  ],
  "destaque": "2 frases analíticas sobre o tema mais quente do dia. tom de especialista. tudo em português"
}

Selecione exatamente 3 notícias priorizando relevância para Backend, Data Engineering e IA.
Os índices em "noticias" devem corresponder aos números da lista acima.`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
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

  return parseJSON(raw);
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Remove code block markdown se presente
    const stripped = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    try {
      return JSON.parse(stripped);
    } catch {
      // Tenta extrair JSON do texto
      const match = stripped.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          // limpa quebras de linha dentro das strings antes de parsear
          const cleaned = match[0].replace(/\\\n/g, "\\n");
          return JSON.parse(cleaned);
        }
      }
      console.error("Resposta bruta do Groq:\n" + raw);
      throw new Error("Resposta do Groq não é JSON válido");
    }
  }
}

// Montagem

function buildReadme(template, allNews, content) {
  const rows = content.noticias.map((item) => {
    const news = allNews[item.index - 1];
    if (!news) return null;
    return `**[${news.title}](${news.url})**  \n\`${news.source.toLowerCase()}\` — ${item.impacto}`;
  }).filter(Boolean);

  const noticias = rows.join("\n\n");

  return template
    .replace("{{NOTICIAS}}", noticias)
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
  let content;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      content = await generateContent(allNews);
      break;
    } catch (e) {
      console.error(`Tentativa ${attempt}/3 falhou: ${e.message}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const templatePath = path.join(__dirname, "..", "template.md");
  const template = fs.readFileSync(templatePath, "utf-8");

  const readme = buildReadme(template, allNews, content);

  const readmePath = path.join(__dirname, "..", "README.md");
  fs.writeFileSync(readmePath, readme, "utf-8");

  console.log("3. Gerando README");
  console.log(`Salvo em: ${readmePath}`);
}

main().catch((e) => {
  console.error("❌ Erro fatal:", e);
  process.exit(1);
});