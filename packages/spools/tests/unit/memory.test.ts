import { expect, test } from 'bun:test'

import { createMemory } from '../../src/crm/memory'

type Session = { user: string | null; favorites: number }

function setup(options: { remember?: boolean } = {}) {
  const state = {
    clock: 0,
    asked: 0,
    searched: 0,
    titlesAsked: 0,
    answer: { user: 'ada', favorites: 1 } as Session,
  }

  const memory = createMemory<Session, string[]>({
    session: async () => {
      state.asked++
      return { ...state.answer }
    },
    search: async (objectKey, q) => {
      state.searched++
      return [`${objectKey}:${q}`]
    },
    title: async (objectKey, id) => {
      state.titlesAsked++
      return id === 'gone' ? null : `${objectKey} ${id}`
    },
    usable: (s) => s.user !== null,
    remember: options.remember ?? true,
    sessionFreshMs: 60_000,
    titlesFreshMs: 60_000,
    now: () => state.clock,
  })

  return { state, memory }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a session is asked for once, then answered from memory', async () => {
  const { state, memory } = setup()
  expect(await memory.session()).toEqual({ user: 'ada', favorites: 1 })
  expect(await memory.session()).toEqual({ user: 'ada', favorites: 1 })
  expect(state.asked).toBe(1)
})

test('navigations that start together share one request', async () => {
  const { state, memory } = setup()
  await Promise.all([memory.session(), memory.session(), memory.session()])
  expect(state.asked).toBe(1)
})

test('an old session is still answered at once, and refreshed behind for the next page', async () => {
  const { state, memory } = setup()
  await memory.session()
  state.clock = 61_000
  state.answer = { user: 'ada', favorites: 2 }
  expect((await memory.session()).favorites).toBe(1)
  await settle()
  expect(state.asked).toBe(2)
  expect((await memory.session()).favorites).toBe(2)
})

test('forgetting makes the next navigation ask again', async () => {
  const { state, memory } = setup()
  await memory.session()
  state.answer = { user: 'ada', favorites: 5 }
  memory.forget()
  expect((await memory.session()).favorites).toBe(5)
  expect(state.asked).toBe(2)
})

test('an answer that was on its way when things changed is not kept', async () => {
  const state = { release: (_: Session) => {}, asked: 0 }

  const memory = createMemory<Session, string[]>({
    session: () => {
      state.asked++
      return state.asked === 1
        ? new Promise<Session>((resolve) => {
            state.release = resolve
          })
        : Promise.resolve({ user: 'ada', favorites: 9 })
    },
    search: async () => [],
    title: async () => null,
    usable: (s) => s.user !== null,
    remember: true,
  })

  const early = memory.session()
  memory.forget()
  state.release({ user: 'ada', favorites: 0 })
  await early
  expect((await memory.session()).favorites).toBe(9)
})

test('someone signed out is never remembered', async () => {
  const { state, memory } = setup()
  state.answer = { user: null, favorites: 0 }
  await memory.session()
  await memory.session()
  expect(state.asked).toBe(2)
  memory.keep({ user: null, favorites: 0 })
  await memory.session()
  expect(state.asked).toBe(3)
})

test("a session sent with the page is kept, so the first click doesn't ask", async () => {
  const { state, memory } = setup()
  memory.keep({ user: 'ada', favorites: 3 })
  expect((await memory.session()).favorites).toBe(3)
  expect(state.asked).toBe(0)
})

test('nothing is remembered on the server', async () => {
  const { state, memory } = setup({ remember: false })
  memory.keep({ user: 'ada', favorites: 3 })
  await memory.session()
  await memory.session()
  await memory.search('deals', 'ac')
  await memory.search('deals', 'ac')
  await memory.title('deals', 'd1')
  await memory.title('deals', 'd1')
  expect(state.asked).toBe(2)
  expect(state.searched).toBe(2)
  expect(state.titlesAsked).toBe(2)
})

test("a picker's search is reused for a while, per object and per text typed, and forgotten on change", async () => {
  const { state, memory } = setup()
  expect(await memory.search('deals', 'ac')).toEqual(['deals:ac'])
  await memory.search('deals', 'ac')
  expect(state.searched).toBe(1)
  // The picker as it opens (nothing typed), other text and another object are questions of their own.
  expect(await memory.search('deals', '')).toEqual(['deals:'])
  expect(await memory.search('deals', 'a\nc')).toEqual(['deals:a\nc'])
  await memory.search('contacts', 'ac')
  expect(state.searched).toBe(4)
  state.clock = 61_000
  await memory.search('deals', 'ac')
  expect(state.searched).toBe(5)
  memory.forget()
  await memory.search('deals', 'ac')
  expect(state.searched).toBe(6)
})

test("a record's title is asked for once, also when there is no such record", async () => {
  const { state, memory } = setup()
  expect(await memory.title('companies', 'c1')).toBe('companies c1')
  expect(await memory.title('companies', 'c1')).toBe('companies c1')
  expect(await memory.title('companies', 'gone')).toBeNull()
  expect(await memory.title('companies', 'gone')).toBeNull()
  expect(state.titlesAsked).toBe(2)
  memory.forget()
  await memory.title('companies', 'c1')
  expect(state.titlesAsked).toBe(3)
})

test("typing for a long time doesn't make the memory grow without end", async () => {
  const { state, memory } = setup()

  for (let i = 0; i <= 200; i++) {
    await memory.search('deals', `q${i}`)
  }

  expect(state.searched).toBe(201)
  // The newest answers are still held; the oldest made room.
  await memory.search('deals', 'q200')
  await memory.search('deals', 'q1')
  expect(state.searched).toBe(201)
  await memory.search('deals', 'q0')
  expect(state.searched).toBe(202)
})

test('a failed search is not handed to the next asker', async () => {
  let calls = 0

  const memory = createMemory<Session, string[]>({
    session: async () => ({ user: 'ada', favorites: 0 }),
    search: async () => {
      calls++

      if (calls === 1) {
        throw new Error('offline')
      }

      return ['ok']
    },
    title: async () => null,
    usable: () => true,
    remember: true,
  })

  await expect(memory.search('deals', 'a')).rejects.toThrow('offline')
  await settle()
  expect(await memory.search('deals', 'a')).toEqual(['ok'])
})
