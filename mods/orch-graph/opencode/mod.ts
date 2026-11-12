import { join } from 'node:path'
import { OrchGraphMod } from './orchGraphMod'

// The orch-graph mod for herdr-mods (https://github.com/barnuri/herdr-mods): list this file in its `mods` option.
export default OrchGraphMod.definition(join(import.meta.dir, 'view.ts'))
