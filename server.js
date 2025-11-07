import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// ----- Jira 설정 -----
const JIRA_URL = process.env.JIRA_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;
const BOARD_ID = process.env.BOARD_ID;

const jiraHeaders = {
  Authorization:
    "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64"),
  Accept: "application/json",
};

const jiraJsonHeaders = {
  ...jiraHeaders,
  "Content-Type": "application/json"
};

function buildChecklistBlock(label, items) {
  const blocks = [
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [
        {
          type: 'text',
          text: label,
        },
      ],
    },
  ];
  if (!Array.isArray(items) || items.length === 0) {
    blocks.push({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: '(없음)',
        },
      ],
    });
  } else {
    blocks.push({
      type: 'taskList',
      content: items.map((item, idx) => ({
        type: 'taskItem',
        attrs: { state: item?.checked ? 'DONE' : 'TODO' },
        content: [
          {
            type: 'text',
            text:
              (item?.text ?? '').toString().trim() || `(빈 항목 ${idx + 1})`,
          },
        ],
      })),
    });
  }
  return blocks;
}

async function postJiraComment(issueKey, acItems, dodItems) {
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_TOKEN) {
    console.warn('⚠️ Jira 환경변수가 설정되지 않아 댓글을 작성하지 않습니다.');
    return;
  }
  try {
    const body = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          ...buildChecklistBlock('AC', acItems),
          ...buildChecklistBlock('DoD', dodItems),
        ],
      },
    };
    const res = await fetch(
      `${JIRA_URL}/rest/api/3/issue/${issueKey}/comment`,
      {
        method: 'POST',
        headers: jiraJsonHeaders,
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error('❌ Jira 댓글 작성 실패:', res.status, text);
    } else {
      console.log(`✅ Jira 댓글 작성 완료: ${issueKey}`);
    }
  } catch (err) {
    console.error('❌ Jira 댓글 작성 중 오류:', err.message);
  }
}



async function fetchJson(url, options = {}, context = 'request') {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    console.error(`❌ ${context} 실패:`, res.status, text.slice(0, 200));
    throw new Error(`${context} 실패: ${res.status} ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`❌ ${context} JSON 파싱 오류:`, err.message, text.slice(0, 200));
    throw new Error(`${context} JSON 파싱 오류: ${err.message}`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 
    `postgresql://${process.env.PG_USER}:${process.env.PG_PASSWORD}@${process.env.PG_HOST}:${process.env.PG_PORT || 5432}/${process.env.PG_DATABASE}`,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: false,
    require: true
  } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 잘 붙었는지 테스트 (선택)
pool
  .connect()
  .then((client) => {
    console.log("✅ Connected to PostgreSQL");
    client.release();
  })
  .catch((err) => {
    console.error("❌ PostgreSQL connection error:", err.message);
  });

// DB 테이블 자동 생성
pool.query(`
  CREATE TABLE IF NOT EXISTS qa_states (
    issue_key TEXT PRIMARY KEY,
    ac JSONB DEFAULT '[]'::jsonb,
    dod JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMP DEFAULT NOW()
  )
`).then(() => {
  console.log("✅ QA states table ready");
}).catch(err => {
  console.error("❌ Failed to create table:", err.message);
});

// ----- 라우트 -----

// 1) Jira 스프린트 이슈 가져오기
app.get("/api/jira-sprint-issues", async (req, res) => {
  try {
    let { sprintId } = req.query;

    if (!sprintId) {
      const sprintData = await fetchJson(
      `${JIRA_URL}/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`,
      { headers: jiraHeaders },
      'Active sprint 조회'
    );
      const activeSprint = sprintData.values?.[0];
      if (!activeSprint) {
        return res.json({ issues: [] });
      }
      sprintId = activeSprint.id;
    }

    const sprintDetail = await fetchJson(
      `${JIRA_URL}/rest/agile/1.0/sprint/${sprintId}`,
      { headers: jiraHeaders },
      'Sprint 상세 조회'
    );

    const issuesData = await fetchJson(
      `${JIRA_URL}/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=200&fields=summary,assignee,reporter,duedate,labels,status,subtasks`,
      { headers: jiraHeaders },
      'Sprint 이슈 조회'
    );

    const baseIssues = (issuesData.issues || []).map((issue) => ({
      key: issue.key,
      fields: {
        summary: issue.fields?.summary,
        assignee: issue.fields?.assignee
          ? { displayName: issue.fields.assignee.displayName }
          : null,
        reporter: issue.fields?.reporter
          ? { displayName: issue.fields.reporter.displayName }
          : null,
        duedate: issue.fields?.duedate || null,
        labels: Array.isArray(issue.fields?.labels)
          ? issue.fields.labels
          : [],
        subtasks: Array.isArray(issue.fields?.subtasks)
          ? issue.fields.subtasks.map(st => ({ key: st.key, summary: st.fields?.summary || null, status: st.fields?.status?.name || null }))
          : []
      },
      status: issue.fields?.status?.name || "",
    }));

    const parentKeys = baseIssues.map(i => i.key).filter(Boolean);

    let subtasksByParent = {};
    if (parentKeys.length > 0) {
      const jql = `parent in (${parentKeys.map(k => '"' + k + '"').join(',')})`;
      const searchData = await fetchJson(
        `${JIRA_URL}/rest/api/2/search`,
        {
          method: 'POST',
          headers: { ...jiraHeaders, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ jql, fields: [ 'summary', 'status', 'parent' ], maxResults: 1000 })
        },
        'Sub-task 조회'
      );
      const issues = Array.isArray(searchData.issues) ? searchData.issues : [];
      for (const st of issues) {
        const parentKey = st.fields?.parent?.key;
        if (!parentKey) continue;
        if (!subtasksByParent[parentKey]) subtasksByParent[parentKey] = [];
        subtasksByParent[parentKey].push({
          key: st.key,
          summary: st.fields?.summary || null,
          status: st.fields?.status?.name || null,
        });
      }
    }

    const enriched = baseIssues.map(i => ({
      ...i,
      fields: { ...i.fields, subtasks: (subtasksByParent[i.key] && subtasksByParent[i.key].length>0) ? subtasksByParent[i.key] : (i.fields.subtasks || []) }
    }));

    res.json({
      sprint: { id: sprintId, name: (sprintDetail && sprintDetail.name) ? sprintDetail.name : null },
      issues: enriched,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Jira issues", details: err.message });
  }
});

// 2) QA 상태 조회 (DB에서)
app.get("/api/qa-state/:issueKey", async (req, res) => {
  const { issueKey } = req.params;
  try {
    const result = await pool.query(
      "SELECT ac, dod FROM qa_states WHERE issue_key = $1",
      [issueKey]
    );
    if (result.rows.length === 0) {
      return res.json({ ac: [], dod: [] });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load qa state" });
  }
});

// 3) QA 상태 저장 (DB에)
app.post("/api/qa-state/:issueKey", async (req, res) => {
  const { issueKey } = req.params;
  const { ac, dod } = req.body;

  // 안전하게 비어 있는 배열로 보정
  const acJson = JSON.stringify(ac || []);
  const dodJson = JSON.stringify(dod || []);

  try {
    await pool.query(
      `
      INSERT INTO qa_states (issue_key, ac, dod)
      VALUES ($1, $2::jsonb, $3::jsonb)
      ON CONFLICT (issue_key)
      DO UPDATE SET ac = EXCLUDED.ac, dod = EXCLUDED.dod, updated_at = NOW()
      `,
      [issueKey, acJson, dodJson]
    );

    postJiraComment(issueKey, ac || [], dod || []);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save qa state" });
  }
});


// 환경변수 확인
if (!JIRA_URL || !JIRA_EMAIL || !JIRA_TOKEN || !BOARD_ID) {
  console.error("❌ Missing Jira environment variables!");
  console.error("Required: JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, BOARD_ID");
}

// 루트 경로 - qa-ui.html 서빙
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "qa-ui.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
