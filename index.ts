import { readdir as readDir, writeFile, mkdir as mkDir, readFile, copyFile, stat } from "fs/promises"
import { watch as watchDir } from "chokidar"
import { minify } from "terser"
import { resolve as resolvePath, basename, extname } from "path"
import { transpileModule, ScriptTarget } from "typescript"
import { format } from "prettier"

interface Info {
	file: string
	users: string[]
	// srcLength: number
	minLength: number
	error: any
}

const supportedExtensions = [ ".js", ".ts" ]

/**
 * Push a specific or all scripts to a specific or all users.
 * In source directory, scripts in folders will override scripts with same name for user with folder name.
 *
 * e.g. foo/bar.js overrides other bar.js script just for user foo.
 *
 * @param srcDir path to folder containing source files
 * @param hackmudDir path to hackmud directory
 * @param users users to push to (pushes to all if empty)
 * @param scripts scripts to push from (pushes from all if empty)
 * @param onPush function that's called when a script has been pushed
 */
export function push(srcDir: string, hackmudDir: string, users: string[], scripts: string[], onPush?: (info: Info) => void) {
	return new Promise<Info[]>(async resolve => {
		const infoAll: Info[] = []
		const files = await readDir(srcDir, { withFileTypes: true })
		const skips = new Map<string, string[]>()
		const promises: Promise<any>[] = []

		for (const dir of files) {
			const user = dir.name

			if (dir.isDirectory() && (!users.length || users.includes(user))) {
				promises.push(readDir(resolvePath(srcDir, user), { withFileTypes: true }).then(files => {
					for (const file of files) {
						const extension = extname(file.name)
						const name = basename(file.name, extension)

						if (supportedExtensions.includes(extension) && file.isFile() && (!scripts.length || scripts.includes(name))) {
							let skip = skips.get(name)

							if (skip)
								skip.push(user)
							else
								skips.set(name, [ user ])

							readFile(resolvePath(srcDir, user, file.name), { encoding: "utf-8" }).then(async code => {
								let error = null

								const minCode = await processScript(code).catch(reason => {
									error = reason
									return ""
								})

								const info: Info = { file: `${user}/${file.name}`, users: [ user ], minLength: 0, error }

								infoAll.push(info)

								if (!error) {
									if (minCode) {
										info.minLength = hackmudLength(minCode)
										await writeFilePersist(resolvePath(hackmudDir, user, "scripts", `${name}.js`), minCode)
									} else
										info.error = new Error("processed script was empty")
								}

								onPush?.(info)
							})
						}
					}
				}))
			}
		}

		if (!users.length)
			users = (await readDir(hackmudDir, { withFileTypes: true }))
				.filter(a => a.isFile() && extname(a.name) == ".key")
				.map(a => basename(a.name, ".key"))

		Promise.all(promises).then(() => {
			const promises: Promise<any>[] = []

			for (const file of files) {
				if (file.isFile()) {
					const extension = extname(file.name)

					if (supportedExtensions.includes(extension)) {
						const name = basename(file.name, extension)

						if (!scripts.length || scripts.includes(name)) {
							promises.push(readFile(resolvePath(srcDir, file.name), { encoding: "utf-8" }).then(async code => {
								let error = null

								const minCode = await processScript(code).catch(reason => {
									error = reason
									return ""
								})

								const info: Info = { file: file.name, users: [], minLength: 0, error }

								infoAll.push(info)

								if (!error) {
									if (minCode) {
										info.minLength = hackmudLength(minCode)
										const skip = skips.get(name) || []
										const promises: Promise<any>[] = []

										for (const user of users)
											if (!skip.includes(user)) {
												info.users.push(user)
												promises.push(writeFilePersist(resolvePath(hackmudDir, user, "scripts", `${name}.js`), minCode))
											}
									} else
										info.error = new Error("processed script was empty")
								}

								if (onPush)
									Promise.all(promises).then(() => onPush(info))
							}))
						}
					}
				}
			}

			Promise.all(promises).then(() => resolve(infoAll))
		})
	})
}

/**
 * Watches target file or folder for updates and builds and pushes updated file.
 *
 * @param srcDir path to folder containing source files
 * @param hackmudDir path to hackmud directory
 * @param users users to push to (pushes to all if empty)
 * @param scripts scripts to push from (pushes from all if empty)
 * @param onPush function that's called after each script has been built and written
 */
export function watch(srcDir: string, hackmudDir: string, users: string[], scripts: string[], onPush?: (info: Info) => void) {
	watchDir("", { depth: 1, cwd: srcDir, awaitWriteFinish: { stabilityThreshold: 100 } }).on("change", async path => {
		const extension = extname(path)

		if (supportedExtensions.includes(extension)) {
			const name = basename(path, extension)
			const parts = path.split("/")

			switch (parts.length) {
				case 1: {
					const file = path

					if (!scripts.length || scripts.includes(name)) {
						const code = await readFile(resolvePath(srcDir, file), { encoding: "utf-8" })
						const skips = new Map<string, string[]>()
						const promisesSkips: Promise<any>[] = []

						for (const dir of await readDir(srcDir, { withFileTypes: true }))
							if (dir.isDirectory())
								promisesSkips.push(readDir(resolvePath(srcDir, dir.name), { withFileTypes: true }).then(files => {
									for (const file of files) {
										if (file.isFile()) {
											const ext = extname(file.name)

											if (supportedExtensions.includes(ext)) {
												const name = basename(file.name, ext)
												const skip = skips.get(name)

												if (skip)
													skip.push(dir.name)
												else
													skips.set(name, [ dir.name ])
											}
										}
									}
								}))

						await Promise.all(promisesSkips)

						let error = null

						const minCode = await processScript(code).catch(reason => {
							error = reason
							return ""
						})

						const info: Info = { file, users: [], minLength: 0, error }
						const promises: Promise<any>[] = []

						if (!error) {
							if (minCode) {
								const skip = skips.get(name) || []

								info.minLength = hackmudLength(minCode)

								if (!users.length)
									users = (await readDir(hackmudDir, { withFileTypes: true }))
										.filter(a => a.isFile() && extname(a.name) == ".key")
										.map(a => basename(a.name, ".key"))

								for (const user of users)
									if (!skip.includes(user)) {
										info.users.push(user)
										promises.push(writeFilePersist(resolvePath(hackmudDir, user, "scripts", `${name}.js`), minCode))
									}
							} else
								info.error = new Error("processed script was empty")
						}

						if (onPush) {
							await Promise.all(promises)
							onPush(info)
						}
					}

					break
				}

				case 2: {
					const [ user ] = parts

					if ((!users.length || users.includes(user)) && (!scripts.length || scripts.includes(name))) {
						const code = await readFile(resolvePath(srcDir, path), { encoding: "utf-8" })

						let error = null

						const minCode = await processScript(code).catch(reason => {
							error = reason
							return ""
						})

						const info: Info = { file: path, users: [ user ], minLength: 0, error }
						const promises: Promise<any>[] = []

						if (!error) {
							if (minCode) {
								info.minLength = hackmudLength(minCode)
								const promises: Promise<any>[] = []

								for (const user of users)
									info.users.push(user)
									promises.push(writeFilePersist(resolvePath(hackmudDir, user, "scripts", `${name}.js`), minCode))
							} else
								info.error = new Error("processed script was empty")
						}

						if (onPush) {
							await Promise.all(promises)
							onPush(info)
						}
					}

					break
				}
			}
		}
	})
}

/**
 * Copies script from hackmud to local source folder.
 *
 * @param srcPath path to folder containing source files
 * @param hackmudPath path to hackmud directory
 * @param script script to pull in `user.name` format
 */
export async function pull(srcPath: string, hackmudPath: string, script: string) {
	const [ user, name ] = script.split(".")
	await copyFilePersist(resolvePath(hackmudPath, user, "scripts", `${name}.js`), resolvePath(srcPath, user, `${name}.js`))
}

export async function syncMacros(hackmudPath: string) {
	const files = await readDir(hackmudPath, { withFileTypes: true })
	const macros = new Map<string, { macro: string, date: Date }>()
	const users: string[] = []

	for (const file of files) {
		if (file.isFile())
			switch (extname(file.name)) {
				case ".macros": {
					const lines = (await readFile(resolvePath(hackmudPath, file.name), { encoding: "utf-8" })).split("\n")
					const date = (await stat(resolvePath(hackmudPath, file.name))).mtime

					for (let i = 0; i < lines.length / 2 - 1; i++) {
						const macroName = lines[i * 2]
						const curMacro = macros.get(macroName)

						if (!curMacro || date > curMacro.date)
							macros.set(macroName, { date, macro: lines[i * 2 + 1] })
					}

					break
				}

				case ".key": {
					users.push(basename(file.name, ".key"))
					break
				}
			}
	}

	let macroFile = ""
	let macrosSynced = 0

	for (const [ name, { macro } ] of [ ...macros ].sort(([ a ], [ b ]) => (a as any > b as any) - (a as any < b as any)))
		if (macro[0] == macro[0].toLowerCase()) {
			macroFile += `${name}\n${macro}\n`
			macrosSynced++
		}

	for (const user of users)
		writeFile(resolvePath(hackmudPath, user + ".macros"), macroFile)

	return { macrosSynced, usersSynced: users.length }
}

export async function test(srcPath: string) {
	const promises: Promise<any>[] = []

	const errors: {
		file: string
		error: any
	}[] = []

	for (const dirent of await readDir(srcPath, { withFileTypes: true }))
		if (dirent.isDirectory()) {
			for (const file of await readDir(resolvePath(srcPath, dirent.name), { withFileTypes: true }))
				if (file.isFile() && supportedExtensions.includes(extname(file.name)))
					promises.push(processScript(await readFile(resolvePath(srcPath, dirent.name, file.name), { encoding: "utf-8" }))
						.catch(error => errors.push({ error, file: `${dirent.name}/${file.name}` })))
		} else if (dirent.isFile() && supportedExtensions.includes(extname(dirent.name)))
			promises.push(processScript(await readFile(resolvePath(srcPath, dirent.name), { encoding: "utf-8" })).catch(error => errors.push({ error, file: dirent.name })))

	await Promise.all(promises)

	return errors
}

/**
 * Minifies a given script
 *
 * @param script JavaScript or TypeScript code
 */
export async function processScript(script: string) {
	const autocompleteMatch = script.match(/^(?:\/\/ @autocomplete (.+)|function(?: \w+| )?\([^\)]*\)\s*{\s*\/\/(.+))\n/)

	if (script.startsWith("export function"))
		script = script.replace("export ", "")

	script = script
		.replace(/[#\$]([\w.]+\()/g, a => "$" + a.slice(1).replace(/\./g, "$"))
		.replace(/^function\s*\(/, "function script(")

	// compilation
	script = transpileModule(script, {
		compilerOptions: {
			target: ScriptTarget.ES2015,
			strict: false
		}
	}).outputText

	// minification
	script = (await minify(script, {
			compress: {
				keep_fargs: false,
				negate_iife: false,
				// booleans_as_integers: true,
				unsafe_undefined: true,
				unsafe_comps: true,
				unsafe_proto: true,
				passes: 2,
				ecma: 2017
			}
	})).code || ""

	// extra formatting to get the non whitespace character count lower
	script = format(script, {
		semi: false,
		parser: "babel",
		arrowParens: "avoid",
		bracketSpacing: false,
		tabWidth: 0,
		trailingComma: "none",
		printWidth: Infinity
	})

	script = script
		.replace(/\$[\w\$]+\(/g, a => a.replace("$", "#").replace(/\$/g, "."))
		.replace(/function ?\w+\(/, "function (")

	if (autocompleteMatch)
		return script.replace(/function \(.*\) \{/, `$& // ${(autocompleteMatch[1] || autocompleteMatch[2]).trim()}`)

	return script
}

type WriteFileParameters = Parameters<typeof writeFile>

async function writeFilePersist(path: string, data: WriteFileParameters[1], options?: WriteFileParameters[2]) {
	await writeFile(path, data, options).catch(async (error: NodeJS.ErrnoException) => {
		switch (error.code) {
			case "ENOENT":
				await mkDir(resolvePath(path, ".."), { recursive: true })
				await writeFile(path, data, options)
				break
			default:
				throw error
		}
	})
}

type CopyFileParameters = Parameters<typeof copyFile>

async function copyFilePersist(path: CopyFileParameters[0], dest: string, flags?: CopyFileParameters[2]) {
	await copyFile(path, dest, flags).catch(async (error: NodeJS.ErrnoException) => {
		switch (error.code) {
			case "ENOENT":
				await mkDir(resolvePath(dest, ".."), { recursive: true })
				await copyFile(path, dest, flags)
				break
			default:
				throw error
		}
	})
}

function hackmudLength(script: string) {
	return script.replace(/[ \n\r]/g, "").length
}
