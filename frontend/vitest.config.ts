import { getViteConfig } from 'astro/config'

// Node >= 25 ships a global localStorage that shadows happy-dom's in DOM tests.
const nodeMajor = Number(process.versions.node.split('.')[0])
const execArgv = nodeMajor >= 22 ? ['--no-experimental-webstorage'] : []

export default getViteConfig({
  test: {
    poolOptions: {
      forks: { execArgv },
    },
  },
})
