/**
 * Agent / skill wiring tests.
 *
 * The failure mode these lock down is silent: a skills folder that does not
 * exist, or front-matter the loader cannot parse, results in prompts being sent
 * with zero brand context — no error, just quietly worse output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join('/tmp', 'atoz-agents-'));
process.env.ATOZ_DATA_DIR = path.join(tmpDir, 'data');

const ai = await import('../app/server/src/services/ai.js');
const { loadSkillIndex, buildContext, listSkills, readSkill, agentRoster, AGENTS, invalidateSkills } = ai;

test('the skills folder exists and is non-empty', () => {
  const dir = path.resolve('skills');
  assert.ok(fs.existsSync(dir), 'skills/ must exist — without it every prompt loses its rules');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.md'));
  assert.ok(files.length >= 4, `expected at least 4 skills, found ${files.length}`);
});

test('knowledge-base exists and is injected into every agent', () => {
  const index = loadSkillIndex({ force: true });
  assert.ok(index.knowledge.length >= 1, 'brand knowledge must exist');
  for (const agent of AGENTS) {
    const ctx = buildContext(agent.id);
    assert.ok(ctx.chars > 0, `${agent.id} received an empty context`);
    assert.ok(ctx.text.includes('AtoZ'), `${agent.id} context is missing brand knowledge`);
  }
});

test('front-matter is parsed into real metadata', () => {
  const { skills } = loadSkillIndex({ force: true });
  const persian = skills.find((s) => s.id === 'persian-copy');
  assert.ok(persian, 'persian-copy skill missing');
  assert.ok(persian.title.length > 5);
  assert.ok(persian.agents.includes('SCRIPT_DIR'));
  assert.equal(persian.inject, true);
  assert.ok(persian.tags.includes('rtl'));
  assert.ok(!persian.body.startsWith('---'), 'front-matter must be stripped from the body');
});

test('each agent gets the skills that name it, and only those', () => {
  const script = buildContext('SCRIPT_DIR');
  assert.ok(script.applied.includes('reel-structure'));
  assert.ok(script.applied.includes('carousel-blueprint'));

  const atooz = buildContext('ATOOZ_CORE');
  assert.ok(!atooz.applied.includes('carousel-blueprint'), 'carousel rules leaked into the assistant');
  assert.ok(atooz.applied.includes('persian-copy'));

  const mkt = buildContext('MKT_DIR');
  assert.ok(mkt.applied.includes('data-storytelling'));
  assert.ok(!mkt.applied.includes('reel-structure'), 'reel rules leaked into ideation');
});

test('context stays inside the prompt budget', () => {
  for (const agent of AGENTS) {
    const ctx = buildContext(agent.id);
    assert.ok(ctx.chars < 15_000, `${agent.id} context is ${ctx.chars} chars — over budget`);
  }
});

test('the roster reports skills, run counts and no undefined fields', () => {
  const roster = agentRoster();
  assert.equal(roster.length, AGENTS.length);
  for (const agent of roster) {
    assert.ok(agent.skills.length > 0, `${agent.id} has no injected skills`);
    assert.equal(typeof agent.contextChars, 'number');
    assert.equal(typeof agent.runs, 'number');
    assert.ok(agent.promptKey);
    assert.ok(agent.schema);
  }
});

test('exactly one agent is allowed to act on the user\'s behalf', () => {
  const actors = AGENTS.filter((a) => a.canAct).map((a) => a.id);
  assert.deepEqual(actors, ['ATOOZ_CORE'], 'only the assistant may trigger side effects');
});

test('every agent prompt key exists in the prompt store', () => {
  const prompts = ai.getPrompts();
  for (const agent of AGENTS) {
    assert.ok(prompts[agent.promptKey], `${agent.id} references missing prompt ${agent.promptKey}`);
    assert.ok(prompts[agent.promptKey].length > 40, `prompt ${agent.promptKey} looks empty`);
  }
});

test('a message from one skill never bleeds into another skill body', () => {
  const reel = readSkill('reel-structure');
  const carousel = readSkill('carousel-blueprint');
  assert.ok(reel.body.includes('۱۰۸۰×۱۹۲۰'));
  assert.ok(carousel.body.includes('۱۰۸۰×۱۳۵۰'));
  assert.ok(!reel.body.includes('۱۰۸۰×۱۳۵۰'));
});

test('listSkills exposes previews but not whole bodies', () => {
  const listed = listSkills();
  for (const skill of listed.skills) {
    assert.ok(skill.preview.length <= 260, `${skill.id} preview too long`);
    assert.equal(skill.body, undefined, 'listSkills must not ship full bodies');
  }
});

test('invalidateSkills picks up a newly added file', () => {
  const dir = path.resolve('skills', 'zz-test-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nid: zz-test-skill\ntitle: تست\nagents: ATOOZ_CORE\ninject: true\n---\n# body\n'
  );
  try {
    invalidateSkills();
    const ctx = buildContext('ATOOZ_CORE');
    assert.ok(ctx.applied.includes('zz-test-skill'), 'reload did not pick up the new skill');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    invalidateSkills();
  }
});

test('a skill with inject:false stays out of prompts', () => {
  const dir = path.resolve('skills', 'zz-off-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nid: zz-off-skill\nagents: ATOOZ_CORE\ninject: false\n---\nsecret\n');
  try {
    invalidateSkills();
    assert.ok(!buildContext('ATOOZ_CORE').applied.includes('zz-off-skill'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    invalidateSkills();
  }
});

test('AI mode reflects the configured provider', () => {
  const status = ai.aiStatus();
  assert.ok(['cloud', 'local-llm', 'local'].includes(status.mode));
  assert.equal(typeof status.hasKey, 'boolean');
  assert.ok(status.skills >= 4);
  assert.equal(status.agents, AGENTS.length);
});

test('cleanup', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
