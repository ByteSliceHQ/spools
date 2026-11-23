#!/usr/bin/env bun
/**
 * Seed local data for development. Safe to re-run: skips if companies exist.
 * Usage: bun run db:seed
 */
import '../src/spool.server'
import * as records from '@swirls/spools/server/records'
import { disposeRuntime, runServer } from '@swirls/spools/server/runtime'
import * as workspace from '@swirls/spools/server/workspace'

// Raw creates, without hooks or automations: seed data shouldn't start workflows.
const createRecord = (...args: Parameters<typeof records.createRecord>) =>
  runServer(records.createRecord(...args))

const listRecords = (...args: Parameters<typeof records.listRecords>) =>
  runServer(records.listRecords(...args))

const createTask = (...args: Parameters<typeof workspace.createTask>) =>
  runServer(workspace.createTask(...args))

const createNote = (...args: Parameters<typeof workspace.createNote>) =>
  runServer(workspace.createNote(...args))

if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to seed in production')
  process.exit(1)
}

const existing = await listRecords({ objectKey: 'companies', limit: 1 })

if (existing.length > 0) {
  console.log('Seed skipped: data already present')
} else {
  const acme = await createRecord(
    'companies',
    { name: 'Initech', domain: 'https://initech.example', industry: 'software', employees: 120 },
    'seed',
  )

  const globex = await createRecord(
    'companies',
    { name: 'Globex', domain: 'https://globex.example', industry: 'finance', employees: 800 },
    'seed',
  )

  const ada = await createRecord(
    'contacts',
    { name: 'Ada Lovelace', email: 'ada@initech.example', companyId: acme.id, status: 'qualified' },
    'seed',
  )

  const grace = await createRecord(
    'contacts',
    {
      name: 'Grace Hopper',
      email: 'grace@globex.example',
      companyId: globex.id,
      status: 'customer',
      source: 'referral',
    },
    'seed',
  )

  await createRecord(
    'contacts',
    { name: 'Alan Turing', email: 'alan@example.org', status: 'lead' },
    'seed',
  )

  await createRecord(
    'deals',
    {
      title: 'Initech platform rollout',
      value: 48000,
      stage: 'proposal',
      companyId: acme.id,
      contactId: ada.id,
      closeDate: '2026-12-15',
    },
    'seed',
  )

  const expansion = await createRecord(
    'deals',
    {
      title: 'Globex expansion',
      value: 120000,
      stage: 'negotiation',
      companyId: globex.id,
      contactId: grace.id,
      closeDate: '2027-01-31',
    },
    'seed',
  )

  await createRecord(
    'deals',
    {
      title: 'Globex pilot',
      value: 15000,
      stage: 'won',
      companyId: globex.id,
      contactId: grace.id,
    },
    'seed',
  )

  // Seeded tasks have no real assignee, so they show under "All tasks".
  await createTask(
    { title: 'Send Globex the revised proposal', objectKey: 'deals', recordId: expansion.id },
    'seed',
  )

  await createTask(
    { title: 'Book a kickoff call with Ada', objectKey: 'contacts', recordId: ada.id },
    'seed',
  )

  await createNote(
    {
      title: 'Pricing call',
      body: 'They want annual billing and a multi-year discount. Decision by the end of the month.',
      objectKey: 'deals',
      recordId: expansion.id,
    },
    { id: 'seed', name: 'Seed data' },
  )

  console.log('✓ Seeded 2 companies, 3 contacts, 3 deals, 2 tasks, 1 note')
}

// Closes the database pool, so the script ends.
await disposeRuntime()
