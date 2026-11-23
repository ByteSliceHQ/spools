import { defineRule, eslintCompatPlugin } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

/**
 * Lint rules that keep server code behind the session check, for an app and for
 * the framework. A new Spool's .oxlintrc.json turns on the ones for apps:
 *
 *   "jsPlugins": [{ "name": "spools", "specifier": "@swirls/spools/oxlint" }]
 */

const HANDLERS = '@swirls/spools/handlers'
const SERVER_FUNCTION_HANDLERS = new Set(['crmHandler', 'publicHandler'])
const ROUTE_ADAPTERS = new Set(['apiRoute', 'cronRoute', 'publicRoute', 'toolRoute'])

const API = '@swirls/spools/api/'

/** What a file's top level brings in and declares, by the name it has in the file. */
type Scope = {
  /** An import's module, and the name it has there ("default" and "*" for the two other kinds). */
  readonly imports: ReadonlyMap<string, { source: string; name: string }>
  /** What a top-level `const` is set to. */
  readonly declared: ReadonlyMap<string, ESTree.Node>
}

const NOTHING: Scope = { imports: new Map(), declared: new Map() }

function scopeOf(program: ESTree.Program): Scope {
  const imports = new Map<string, { source: string; name: string }>()
  const declared = new Map<string, ESTree.Node>()

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        imports.set(specifier.local.name, {
          source: statement.source.value,
          name:
            specifier.type === 'ImportDefaultSpecifier'
              ? 'default'
              : specifier.type === 'ImportNamespaceSpecifier'
                ? '*'
                : 'name' in specifier.imported
                  ? specifier.imported.name
                  : specifier.imported.value,
        })
      }
    }

    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type === 'VariableDeclaration') {
      for (const { id, init } of declaration.declarations) {
        if (id.type === 'Identifier' && init) {
          declared.set(id.name, init)
        }
      }
    }
  }

  return { imports, declared }
}

/**
 * Whether a node calls one of these functions as the file imported it. The name
 * it goes by in the file doesn't matter, and a function the file made itself
 * and gave one of the names is not one of them.
 */
function calls(
  node: ESTree.Node | null | undefined,
  names: ReadonlySet<string>,
  scope: Scope,
): boolean {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier') {
    return false
  }

  const imported = scope.imports.get(node.callee.name)
  return imported !== undefined && names.has(imported.name)
}

/**
 * Whether a chain of calls (`createServerFn().validator(...)`) starts with
 * createServerFn: under its own name or another, off a namespace
 * (`start.createServerFn()`), or kept in a `const` and carried on from there.
 */
function startsWithServerFn(node: ESTree.Node, scope: Scope, depth = 0): boolean {
  // A const that names itself would go round for ever.
  if (depth > 20) {
    return false
  }

  if (node.type === 'CallExpression') {
    const { callee } = node

    if (callee.type === 'Identifier') {
      return (
        callee.name === 'createServerFn' ||
        scope.imports.get(callee.name)?.name === 'createServerFn'
      )
    }

    if (
      callee.type === 'MemberExpression' &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'createServerFn'
    ) {
      return true
    }

    return startsWithServerFn(callee, scope, depth + 1)
  }

  if (node.type === 'MemberExpression') {
    return startsWithServerFn(node.object, scope, depth + 1)
  }

  if (node.type === 'Identifier') {
    const set = scope.declared.get(node.name)
    return set !== undefined && startsWithServerFn(set, scope, depth + 1)
  }

  return false
}

const serverFunctionHandlers = defineRule({
  meta: {
    type: 'problem',
    docs: { description: "Every server function's handler runs through the Effect boundary." },
    messages: {
      boundary: `A server function's handler must be crmHandler(...) or publicHandler(...) from ${HANDLERS}, so that it checks who is asking before it answers. See https://spools.codes/docs/extending#pages-and-endpoints-of-your-own.`,
    },
  },
  create(context) {
    let scope = NOTHING

    return {
      Program(node) {
        scope = scopeOf(node)
      },
      CallExpression(node) {
        const { callee } = node

        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'handler' ||
          !startsWithServerFn(callee.object, scope)
        ) {
          return
        }

        const [handler] = node.arguments

        if (!calls(handler, SERVER_FUNCTION_HANDLERS, scope)) {
          context.report({ node: handler ?? node, messageId: 'boundary' })
        }
      },
    }
  },
})

const serverFunctionFiles = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'A *.functions.ts file is imported by browser code, where only its server functions are replaced with calls to the server.',
    },
    messages: {
      onlyFunctions:
        'A *.functions.ts file exports only server functions (createServerFn(...)): browser code imports it, and anything else here would be bundled for the browser with its server imports. Put it in another module.',
    },
  },
  create(context) {
    let scope = NOTHING

    return {
      Program(node) {
        scope = scopeOf(node)
      },
      ExportNamedDeclaration(node) {
        const { declaration } = node

        // A type is gone by the time there is a bundle.
        if (
          !declaration ||
          declaration.type === 'TSTypeAliasDeclaration' ||
          declaration.type === 'TSInterfaceDeclaration'
        ) {
          return
        }

        if (declaration.type !== 'VariableDeclaration') {
          context.report({ node: declaration, messageId: 'onlyFunctions' })
          return
        }

        for (const { id, init } of declaration.declarations) {
          if (!init || !startsWithServerFn(init, scope)) {
            context.report({ node: id, messageId: 'onlyFunctions' })
          }
        }
      },
      ExportDefaultDeclaration(node) {
        context.report({ node, messageId: 'onlyFunctions' })
      },
    }
  },
})

const routeAdapters = defineRule({
  meta: {
    type: 'problem',
    docs: { description: "Every API route's methods run through one of the route adapters." },
    messages: {
      adapter: `An API route's handler must be one of the route adapters (apiRoute, cronRoute, publicRoute, toolRoute) from ${HANDLERS}, so that it checks who is calling before it answers. See https://spools.codes/docs/extending#pages-and-endpoints-of-your-own.`,
      elsewhere: `A route's handlers are written in the route's own file, each with a route adapter from ${HANDLERS}, or are the framework's from ${API}*. Handlers from anywhere else can't be shown to check who is calling.`,
    },
  },
  create(context) {
    let scope = NOTHING

    /** One method's handler: a route adapter's call, or a `const` in this file set to one. */
    function method(handler: ESTree.Node) {
      const made = handler.type === 'Identifier' ? scope.declared.get(handler.name) : handler

      if (!calls(made, ROUTE_ADAPTERS, scope)) {
        context.report({ node: handler, messageId: 'adapter' })
      }
    }

    /** A whole set of handlers: written out here, the framework's own, or the two spread together. */
    function check(handlers: ESTree.Node, depth = 0) {
      if (handlers.type === 'ObjectExpression') {
        for (const property of handlers.properties) {
          if (property.type === 'Property') {
            method(property.value)
          } else {
            check(property.argument, depth + 1)
          }
        }

        return
      }

      if (handlers.type === 'Identifier' && depth < 20) {
        const here = scope.declared.get(handlers.name)

        if (here) {
          check(here, depth + 1)
          return
        }

        if (scope.imports.get(handlers.name)?.source.startsWith(API)) {
          return
        }
      }

      context.report({ node: handlers, messageId: 'elsewhere' })
    }

    return {
      Program(node) {
        scope = scopeOf(node)
      },
      // The framework's: export const fileHandlers = { GET: ... }
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.id.name.endsWith('Handlers') && node.init) {
          check(node.init)
        }
      },
      // An app's route: createFileRoute(...)({ server: { handlers: { GET: ... } } })
      Property(node) {
        if (node.key.type === 'Identifier' && node.key.name === 'handlers') {
          check(node.value)
        }
      },
    }
  },
})

const effectModules = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Server modules are written as Effect programs with typed errors.' },
    messages: {
      noThrow:
        'Server code fails with a typed error (`return yield* new Invalid({ message })`), not `throw`, so the failure shows in its type and staff see its message. See docs/server-code.md.',
      noAsync:
        "Server modules export Effect functions (`export const x = Effect.fn('module.x')(function* () { ... })`), not async functions. See docs/server-code.md.",
    },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        context.report({ node, messageId: 'noThrow' })
      },
      ExportNamedDeclaration(node) {
        if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.async) {
          context.report({ node: node.declaration, messageId: 'noAsync' })
        }
      },
    }
  },
})

export default eslintCompatPlugin({
  meta: { name: 'spools' },
  rules: {
    'server-function-handlers': serverFunctionHandlers,
    'server-function-files': serverFunctionFiles,
    'route-adapters': routeAdapters,
    'effect-modules': effectModules,
  },
})
