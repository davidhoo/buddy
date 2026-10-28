import { catalogRepositoryKey } from './skill-catalog'

export { catalogRepositoryKey }

/** Offline curated MCP cards for the library Discover section. Templates only; assign writes native config later. */
export interface FeaturedMcp {
  id: string
  name: string
  description: string
  source: string
  version: string
  /** JSON MCP server body stored in the library SavedMcp.server field. */
  server: {
    command: string
    args?: string[]
    env?: Record<string, string>
  }
}

export const FEATURED_MCPS: FeaturedMcp[] = [
  {
    id: 'buddy-mcp-memory',
    name: 'memory',
    description: 'Knowledge-graph memory MCP over stdio. Add to the library, then turn on agents that support JSON mcpServers.',
    source: 'Buddy',
    version: '1.0.0',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory']
    }
  },
  {
    id: 'buddy-mcp-filesystem',
    name: 'filesystem',
    description: 'Local filesystem MCP. Default root is `.`; change the path in the library file before assigning if you need another directory.',
    source: 'Buddy',
    version: '1.0.0',
    server: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
    }
  },
  {
    id: 'buddy-mcp-sqlite',
    name: 'sqlite',
    description: 'SQLite MCP template. Default db is `./data.db`; edit the library JSON before assigning.',
    source: 'Buddy',
    version: '1.0.0',
    server: {
      command: 'npx',
      args: ['-y', 'mcp-server-sqlite', '--db-path', './data.db']
    }
  }
]

export function findFeaturedMcp(id: string): FeaturedMcp | undefined {
  return FEATURED_MCPS.find((entry) => entry.id === id)
}
