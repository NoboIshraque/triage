/*---------------------------------------------------------------------------------------------
 *  Triage. Licensed under GPL-3.0-or-later (see docs/PLAN.md §5).
 *  The Schematic and Board tabs' command ids (their own file: the views run them
 *  from their buttons and right-click menu, and edaCommands.ts imports the views).
 *--------------------------------------------------------------------------------------------*/

export const EDA_COMMANDS = {
	benchmark: 'triage.eda.benchmarkView',
	reload: 'triage.eda.reload',
	renameNet: 'triage.eda.renameNet',
	edit: 'triage.eda.edit',
	save: 'triage.eda.save',
	openInKicad: 'triage.eda.openInKicad',
	select: 'triage.eda.selectReferences',
	restartEngine: 'triage.eda.restartEngine',
} as const;
