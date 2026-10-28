//#region src/speech.ts
function e() {
	let e = "";
	return (t) => {
		let n = (e + t).split("\n");
		return e = n.pop(), n.flatMap((e) => {
			let [t, n, ...r] = e.split("	");
			return n && t !== "cursor" ? [{
				cursor: Number(t),
				role: n,
				text: r.join("	")
			}] : [];
		});
	};
}
var t = (e) => e.replace(/```[\s\S]*?(```|$)/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "").replace(/(\*\*|__|~~|\*|`)(.+?)\1/g, "$2").replace(/(^|[^\p{L}\p{N}_.%+-])@(?=[\p{L}\p{N}_])/gu, "$1").replace(/\s+/g, " ").trim();
//#endregion
//#region src/targeting.ts
function n(e) {
	let t = "berd-call.agent-targeting", n = e.getItem(t) === "picker" ? "picker" : "names", r = /* @__PURE__ */ new Set();
	return {
		get: () => n,
		set(i) {
			e.setItem(t, i), n = i, r.forEach((e) => e());
		},
		subscribe(e) {
			return r.add(e), () => void r.delete(e);
		}
	};
}
var r = (e) => /^\s*(?:everyone|everybody)(?=$|[\s,!.?:;])/iu.test(e);
function i(e, t, n) {
	let r = t.flatMap((e) => {
		let t = n.find((t) => t.pubkey === e)?.name;
		return t ? [t] : [];
	});
	if (!r.length) return e;
	let i = (e) => e.toLocaleLowerCase().replace(/\s+/gu, " "), a = [...r].sort((e, t) => t.length - e.length).map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/gu, "\\s+")), o = RegExp(`(?<![\\p{L}\\p{N}_@])@?(?:${a.join("|")})(?![\\p{L}\\p{N}_])`, "giu"), s = /* @__PURE__ */ new Set(), c = e.replace(o, (e) => {
		let t = r.find((t) => i(t) === i(e.replace(/^@/, "")));
		return s.add(t), `@${t}`;
	}), l = r.filter((e) => !s.has(e)).map((e) => `@${e}`).join(" ");
	return l ? `${l} ${c}` : c;
}
function a(e, t, n) {
	let r = (e) => e.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "", i = ` ${r(e)} `, a = t.filter(({ name: e }) => e && i.includes(` ${r(e)} `));
	return a.length ? a.map(({ pubkey: e }) => e) : [...n];
}
function o(e) {
	return [...new Set(e.map(({ name: e }) => e.trim()).filter((e) => e && new TextEncoder().encode(e).length <= 256))].slice(0, 100).flatMap((e) => ["--stt-hint", e]);
}
//#endregion
//#region src/unheard.ts
function s(e) {
	let t = "berd-call.unheard-replies", n = e.getItem(t) === "edit" ? "edit" : "strike", r = /* @__PURE__ */ new Set();
	return {
		get: () => n,
		set(i) {
			e.setItem(t, i), n = i, r.forEach((e) => e());
		},
		subscribe(e) {
			return r.add(e), () => void r.delete(e);
		}
	};
}
var c = (e) => e.replace(/^([ \t]*(?:(?:[-*+>]|\d+[.)]|#{1,6})[ \t]+)?)(.*\S)[ \t]*$/gm, (e, t, n) => `${t}~~${n}~~`);
function l(e, t) {
	let n = t.split(/\s+/).filter(Boolean).length;
	if (!n) return c(e);
	let r = e.split(/(\s+)/), i = r.findIndex((e) => e.trim() && !n--);
	return i < 0 ? e : r.slice(0, i).join("") + c(r.slice(i).join(""));
}
//#endregion
//#region src/early.ts
function u(e) {
	let t = "berd-call.early-words", n = e.getItem(t) === "on", r = /* @__PURE__ */ new Set();
	return {
		get: () => n,
		set(i) {
			e.setItem(t, i ? "on" : "off"), n = i, r.forEach((e) => e());
		},
		subscribe(e) {
			return r.add(e), () => void r.delete(e);
		}
	};
}
var d = (e, t) => `(Berd Call heads-up: ${t ?? "the user"} paused, but their words are still being transcribed and may change: "${e}". You may start on a reply now; one you send is spoken after they finish, as your answer to these words. Their final words follow as a message: answer that only if it changes or adds to what you said.)`, f = {
	stt: "wss://api.openai.com/v1/realtime?intent=transcription",
	tts: "https://api.openai.com/v1/audio/speech"
}, p = Object.keys(f), m = {
	stt: "OpenAI speech recognition",
	tts: "OpenAI voice"
}, h = {
	stt: "--stt-url",
	tts: "--tts-url"
};
function g(e, t) {
	let [n, r] = e === "tts" ? [!1, "http:// or https://"] : [!0, "ws:// or wss://"];
	try {
		let e = new URL(t.trim());
		if (e.protocol.startsWith(n ? "ws" : "http")) return e.toString();
	} catch {}
	throw Error(`Enter a full URL beginning with ${r}.`);
}
async function _(e, t) {
	if (t === f[e]) return "api-key";
	let n = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
	return `endpoint-${[...new Uint8Array(n)].map((e) => e.toString(16).padStart(2, "0")).join("")}`;
}
function v(e) {
	let t = "berd-call.openai-endpoints", n = {};
	try {
		let r = JSON.parse(e.getItem(t) ?? "{}");
		r && typeof r == "object" && !Array.isArray(r) && (n = Object.fromEntries(p.flatMap((e) => typeof r[e] == "string" && r[e] !== f[e] ? [[e, r[e]]] : [])), Object.keys(r).some((e) => !p.includes(e)) && e.setItem(t, JSON.stringify(n)));
	} catch {}
	let r = {
		...f,
		...n
	}, i = /* @__PURE__ */ new Set();
	return {
		get: () => r,
		set(a, o) {
			o === f[a] ? delete n[a] : n[a] = o, e.setItem(t, JSON.stringify(n)), r = {
				...f,
				...n
			}, i.forEach((e) => e());
		},
		subscribe(e) {
			return i.add(e), () => void i.delete(e);
		}
	};
}
//#endregion
//#region src/call.ts
var y = "5223", b = 5e3, x = 3e3, S = (e, t, n = []) => {
	let r = new Map(e.types().map((e) => [e.key, e])), i = e.snapshot().agents, a = i.flatMap((e) => (r.get(e.type)?.sessions?.list(e.pubkey) ?? []).filter((e) => e.channelId === t && !e.root).map((t) => ({
		pubkey: e.pubkey,
		at: t.at ?? 0
	}))).sort((e, t) => t.at - e.at)[0]?.pubkey, o = i.filter((e) => n.includes(e.pubkey));
	return a ?? (o.length === 1 ? o[0].pubkey : void 0);
}, C = (e, t) => ({
	get: () => e.snapshot().agents.some((n) => (e.types().find(({ key: e }) => e === n.type)?.sessions?.list(n.pubkey) ?? []).some((e) => e.channelId === t && !e.root && e.status === "Working")),
	subscribe(t) {
		let n = [e.subscribe(t), ...e.types().map((e) => e.sessions?.subscribe(t))];
		return () => n.forEach((e) => e?.());
	}
}), ee = "(The voice call ended. Your replies are no longer spoken to me.)", w = (e) => {
	let t = e.trim().slice(-160);
	return t ? `(I interrupted your reply after "${t.length < e.trim().length ? "…" : ""}${t}")` : "(I interrupted your reply before hearing any of it)";
}, T = (e) => e instanceof Error ? e.message : String(e);
async function E(e, t, n = [], r = 0) {
	let i = "", a = "", o = await e.spawn(t, {
		args: n,
		onStdout: (e) => void (i += e),
		onStderr: (e) => void (a += e)
	}), s, c = new Promise((e, n) => {
		r && (s = setTimeout(() => {
			n(/* @__PURE__ */ Error(`berd-call ${t} timed out`)), o.kill().catch(() => {});
		}, r));
	}), l;
	try {
		l = await Promise.race([o.exited, c]);
	} finally {
		clearTimeout(s);
	}
	if (l !== 0) throw Error(a.trim().split("\n").pop() || `berd-call exited with ${l}`);
	return i;
}
var te = (e, t) => void e.spawn("timing", { args: [] }).then((e) => e.end(`${JSON.stringify(t)}\n`)).catch(() => {}), D = (e, t, n = [], r = 0) => E(e, t, [
	"--port",
	y,
	...n
], r), O = (e = []) => {
	let t = {};
	for (let n = 0; n + 1 < e.length; n += 2) t[e[n]] = e[n + 1];
	return t;
}, k = {
	stt: {
		macos: "Apple",
		openai: "OpenAI"
	},
	tts: {
		siri: "Apple",
		openai: "OpenAI"
	}
}, A = {
	parakeet: "Parakeet",
	pocket: "Pocket"
}, j = (e) => {
	let t = e["--stt-backend"] ?? "macos", n = e["--tts-backend"] ?? "siri";
	return (t in k.stt || t === "parakeet" && !!e["--stt-model-dir"]) && (n === "openai" || n === "siri" && !!e["--voice"] || n === "pocket" && !!e["--model-dir"] && !!e["--voice"]);
}, M = (e = []) => (O(e)["--mode"] ?? "conventional") !== "conventional" || e.some((e) => /^--(spokesperson|allow-direct-agent-speech)/.test(e)), N = async (e) => JSON.parse(await E(e, "voices", ["list"])).result.voices, ne = async (e) => (await N(e)).filter((e) => e.installed), re = ["Aaron", "Nora"];
async function P(e, t, n = navigator.language) {
	let r = await ne(e), i = r.find((e) => e.name === t?.voice && e.language === t?.language) ?? re.map((e) => r.find((t) => t.name === e)).find(Boolean) ?? r.find((e) => e.language === n) ?? r.find((e) => e.language.split("-")[0] === n.split("-")[0]) ?? r[0];
	if (!i) throw Error("Download an Apple voice in System Settings, under Spoken Content.");
	return [
		"--stt-backend",
		"macos",
		"--tts-backend",
		"siri",
		"--voice",
		i.name,
		"--language",
		i.language,
		"--rate",
		"1"
	];
}
async function ie(e) {
	let t = await E(e, "saved").then(JSON.parse, () => void 0);
	if (t && !M(t.arguments)) return t;
	let n = O(t?.arguments), r = {
		...t,
		tts: void 0,
		arguments: await P(e, {
			voice: n["--voice"],
			language: n["--language"]
		})
	};
	return await ae(e, r), r;
}
async function ae(e, t) {
	let n = await e.spawn("save", { args: [] });
	if (await n.end(JSON.stringify(t, null, 2)), await n.exited) throw Error("Could not save the call settings.");
}
var F = (e) => e.flatMap((t, n) => n % 2 ? [] : [[t, e[n + 1]]]), I = (e, t) => {
	let n = (e) => F(t).some(([t]) => t === e), r = (e) => n(e) || n("--tts-backend") && [
		"--voice",
		"--language",
		"--rate",
		"--model-dir"
	].includes(e) || n("--stt-backend") && e === "--stt-model-dir";
	return [...F(e).filter(([e]) => !r(e)).flat(), ...t];
}, L = ({ tts: e, arguments: t }) => {
	let n = O(t);
	return e ?? {
		backend: n["--tts-backend"] ?? "siri",
		voice: n["--voice"],
		language: n["--language"],
		rate: Number(n["--rate"] ?? 1)
	};
};
async function oe(e, t) {
	let n = await ie(e), r = t[0] === "--restart" ? t.slice(1) : t, i = O(r);
	if (i["--input-during-tts"] === "auto" && !(await E(e, "settings", ["--help"])).includes("--input-during-tts auto|")) throw Error("Update berd-call to use Auto input muting.");
	if (i["--vad-debug-sounds"]) n.vad_debug_sounds = i["--vad-debug-sounds"] === "on";
	else if (i["--status-sounds"]) n.status_sounds = i["--status-sounds"];
	else if (i["--input-during-tts"]) n.input_policy = i["--input-during-tts"] === "auto" ? "auto" : i["--input-during-tts"] === "suppress" ? "suppress_input" : "allow_barge_in";
	else {
		i["--tts-backend"] && i["--tts-backend"] !== n.tts?.backend && delete n.tts;
		let { tts: e } = n;
		e && (i["--voice"] && (e.voice = i["--voice"]), i["--language"] && (e.language = i["--language"]), i["--rate"] && (e.rate = Number(i["--rate"])));
		let t = (e?.backend ?? i["--tts-backend"] ?? O(n.arguments)["--tts-backend"]) === "openai";
		n.arguments = I(n.arguments ?? [], F(r).filter(([e]) => !t || e !== "--voice").flat());
	}
	await ae(e, n);
}
var se = (e) => [...e["--stt-backend"] === "openai" ? ["stt"] : [], ...e["--tts-backend"] === "openai" ? ["tts"] : []];
async function ce(e, t = f) {
	let { arguments: n = [] } = await ie(e), r = O(n);
	if (!j(r)) return {
		args: await P(e, {
			voice: r["--voice"],
			language: r["--language"]
		}),
		keys: ""
	};
	let i = se(r), a = (await Promise.all(i.map(async (e) => `${e.toUpperCase()}=${await _(e, t[e])}`))).join();
	return {
		args: i.flatMap((e) => t[e] === f[e] ? [] : [h[e], t[e]]),
		keys: a
	};
}
function le(n, s, u, f, p, m, h, g) {
	let _ = {}, v = () => {}, S = async (e) => {}, C = [], O = [], k = (e, t) => {}, A = /* @__PURE__ */ new Set(), j = (e) => {
		_ = e;
		for (let e of A) e();
	}, M = Promise.resolve(), N = !1, ne = 0, re = 0;
	async function ae(A, P, ie, ae) {
		if (_.status && _.channelId === P) return;
		let F = ++re;
		if (N) {
			v(), ++ne;
			try {
				await M;
			} finally {
				--ne;
			}
			if (F !== re) {
				!ne && !N && j({ ..._ });
				return;
			}
		}
		N = !0;
		let I;
		M = new Promise((e) => I = e), j({
			channelId: P,
			status: "starting"
		});
		let L = !1;
		v = () => void (L = !0), C = ie;
		let oe = new Set(ie), se = e(), le = /* @__PURE__ */ new Set(), R = /* @__PURE__ */ new Map(), z = 0, ue = !1, de, fe = 0, B, V = [], H = !0, pe, me = Promise.resolve(), he = () => {
			let e = ae.get() ? "working" : "waiting";
			H && !L && _.status === "live" && e !== pe && (pe = e, me = me.then(() => D(n, "settings", ["--conversation-status", e], x)).catch(() => void (pe === e && (pe = void 0))));
		}, ge = !1, _e = () => {
			!H || L || _.status !== "live" || ge || (ge = !0, D(n, "settings", ["--non-blocking", "true"], x).catch(() => {}));
		}, ve = /* @__PURE__ */ new Set(), ye = /* @__PURE__ */ new Map(), be = (e) => {
			for (let t of e) s.note?.(t, P, "(We're on a voice call: what I say reaches you transcribed, and your Buzz messages are spoken to me. You MUST respond to my request BEFORE starting work. Your FIRST action must be to use the Buzz send tool to send one short sentence answering me or saying what you will do. Send that message on its own and wait for the send to finish before any other tool call, tool discovery, file read, search, planning, or implementation. Internal commentary and final assistant text are not published or spoken and do not count as a response. After sending, continue the work and send the result through Buzz. Keep spoken replies brief and easy to listen to.)") && ve.add(t);
		}, xe = (e, t = C) => {
			be(t), t.forEach((e) => ye.delete(e));
			try {
				A.messages.send(P, e, [...t]);
			} catch (e) {
				j({
					..._,
					error: T(e)
				});
			}
		}, Se = () => {
			let e = A.channels.list().channels.find((e) => e.id === P)?.members ?? [];
			return s.snapshot().agents.filter((t) => e.includes(t.pubkey)).map((e) => ({
				pubkey: e.pubkey,
				name: e.name
			}));
		}, U, Ce, we = (e, t, n, r = []) => {
			if (U?.id === e) {
				U.at = Math.max(t, U.at);
				return;
			}
			if (U && (t < U.at || t === U.at && e.localeCompare(U.id) <= 0)) return;
			U = {
				id: e,
				at: t
			};
			let i = Se(), a = (n === A.viewer ? r : i.some((e) => e.pubkey === n) ? [n] : []).filter((e) => i.some((t) => t.pubkey === e));
			Ce = a.length ? a : void 0, a.length && p?.get() === "names" && k(P, a);
		}, W = () => {
			let e = A.channels.window(P).rows.filter((e) => e.audience !== "agents" && !R.has(e.id)).at(-1);
			e && we(e.id, e.createdAtMs ?? e.createdAt * 1e3, e.authorId, e.mentions);
			let t = Ce ?? C;
			return Ce = void 0, t;
		}, Te = (e, t, n) => p?.get() === "names" ? r(e) ? t.map(({ pubkey: e }) => e) : a(e, t, n()) : C, G = (e) => {
			if (!p) return xe(e);
			let t = Se(), n = Te(e, t, W).filter((e) => t.some((t) => t.pubkey === e));
			k(P, n), xe(i(e, n, t), n);
		}, K = () => {
			let { interim: e } = _;
			if (!g?.get() || !s.wake || ue || L || !e || e.cursor <= z || B?.cursor === e.cursor && (B.pause === fe || B.text === e.text)) return;
			B = {
				cursor: e.cursor,
				pause: fe,
				text: e.text,
				at: Date.now(),
				to: /* @__PURE__ */ new Set()
			};
			let t = A.viewer && A.names?.resolve(A.viewer);
			for (let n of Te(e.text, Se(), () => C)) try {
				s.wake(n, {
					channel: P,
					text: d(e.text, t || void 0)
				}), B.to.add(n);
			} catch {}
		}, Ee = (e, t, n) => {
			if (C.includes(e) && s.note?.(e, P, t)) ye.set(e, [...ye.get(e) ?? [], t]);
			else {
				if (C.includes(e)) return xe(t, n);
				if (s.wake) try {
					s.wake(e, {
						channel: P,
						text: t
					});
					return;
				} catch {}
				xe(t, [e]);
			}
		}, De = (e) => e.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
		k = (e, t) => {
			if (e === P && !(t.length === C.length && t.every((e, t) => e === C[t]))) {
				C = t;
				for (let [e, t] of ye) C.includes(e) || (ye.delete(e), Ee(e, t.join("\n"), [e]));
				C.forEach((e) => oe.add(e)), j({ ..._ }), he();
			}
		};
		let Oe = () => {
			j({
				..._,
				inputActive: !1,
				inputSpeaking: void 0,
				interim: void 0
			}), z = 0;
		}, ke = /* @__PURE__ */ new Map(), Ae = Promise.resolve(), je = "", q;
		try {
			if (!A.subscribeIncoming) throw Error("Call from the main window, where replies can be heard.");
			await E(n, "reap", [y]).catch(() => {});
			let { args: e, keys: t } = await ce(n, f?.get());
			if (O = (await E(n, "cli", ["session", "--help"], 3e3).catch(() => "")).includes("--stt-hint") ? o(Se()) : [], L) throw Error("Stopped");
			q = await n.spawn("start", {
				args: [
					t,
					"--port",
					y,
					...e,
					...O
				],
				onStdout(e) {
					_.status === "starting" && (j({
						..._,
						status: "live"
					}), he(), _e());
					for (let t of se(e)) {
						if (t.role === "speech_result") {
							let e = ke.get(t.cursor);
							if (ke.delete(t.cursor), e && !L) try {
								e(JSON.parse(t.text)).catch((e) => j({
									..._,
									error: `Couldn't speak reply: ${T(e)}`
								}));
							} catch {}
							continue;
						}
						if (t.role === "input_activity") {
							if (L) continue;
							try {
								let e = JSON.parse(t.text);
								typeof e.speaking == "boolean" && typeof e.recognizing == "boolean" && (ue && !e.speaking && (de = Date.now(), fe++), ue = e.speaking, j({
									..._,
									inputActive: e.speaking || e.recognizing,
									inputSpeaking: e.speaking
								}), K());
							} catch {}
							continue;
						}
						if (t.role === "user_interim") {
							if (L) continue;
							try {
								let { cursor: e, text: n } = JSON.parse(t.text);
								typeof e == "number" && typeof n == "string" && j({
									..._,
									interim: n ? {
										cursor: e,
										text: h ? h.apply(n) : n
									} : void 0
								}), K();
							} catch {}
							continue;
						}
						if (t.role === "lifecycle" && t.text.startsWith("session restarted")) {
							Oe();
							continue;
						}
						t.role === "user" && (_.interim && _.interim.cursor <= t.cursor && j({
							..._,
							interim: void 0
						}), V.push({
							stopped: de,
							finalized: Date.now()
						}), V.splice(0, V.length - 20), de = void 0);
						let e = t.role === "user" && h ? h.apply(t.text) : t.text;
						t.role === "user" && (G(e), z = t.cursor);
					}
				},
				onStderr(e) {
					je = (je + e).slice(-1e3);
				}
			});
		} catch (e) {
			return k = () => {}, v = () => {}, N = !1, j(L ? {} : {
				channelId: P,
				error: T(e)
			}), I();
		}
		S = async (e) => {
			await e(), z = 0;
		};
		let Me = ae.subscribe(he), Ne, Pe = async (e) => {
			let t = u?.get()[e];
			if (!t || !Object.keys(t).length) return [];
			let r = JSON.parse(await D(n, "status")).session?.tts, i = t[r?.backend];
			if (!i) return [];
			if (Ne ??= E(n, "speak", ["--help"]).then((e) => e.includes("--voice")), !await Ne) return j({
				..._,
				error: "Per-agent voices need a newer berd-call. Using the default voice."
			}), [];
			let [a, o] = i.split("	");
			return [
				"--voice",
				a,
				...r.backend === "siri" && o ? ["--language", o] : []
			];
		}, Fe = (e, r, i = 0, a = "") => {
			let o = t(r), u = B && B.cursor > z && B.to.has(e) && i >= Math.floor(B.at / 1e3) ? B.cursor : z;
			if (o) {
				let t = R.get(a) ?? i * 1e3, d = V.filter(({ finalized: e }) => e <= t).at(-1), f = 0, p, h = () => {
					let t = R.get(a) ?? i * 1e3, n = {
						latest: U && { ...U },
						following: Ce,
						targets: C
					};
					R.delete(a);
					let r = A.channels.window(P).rows.find((e) => e.id === a);
					return we(a, r?.createdAtMs ?? t, e), () => {
						R.set(a, t), U?.id === a && (U = n.latest, Ce = n.following, k(P, n.targets));
					};
				}, g = async (i) => {
					let o = Date.now();
					if (te(n, {
						at: new Date(o).toISOString(),
						agent: e,
						message: a,
						status: i.spoke === !1 ? "unspoken" : String(i.status),
						...d?.stopped && { finalizeMs: d.finalized - d.stopped },
						...d && { agentMs: t - d.finalized },
						queueMs: f - t,
						speakMs: o - f
					}), i.status === "accepted" || i.spoke !== !1 && (i.status !== "interrupted" || De(i.estimatedSpokenText ?? "")) ? p ??= h() : p?.(), i.status === "accepted") return;
					let u = A.messages, g = A.channels.window(P).rows.find((e) => e.id === a), v = g?.content ?? r, y = m?.get() !== "edit", b = async (e, t) => {
						try {
							await u.editOwnedAgent(a, e, g?.attachmentSourceId ?? a);
						} catch (e) {
							j({
								..._,
								error: `${t}: ${T(e)}`
							});
						}
					};
					if (i.spoke === !1) {
						u.editOwnedAgent && await b(y ? c(v) : "", y ? "Couldn't strike through unspoken reply" : "Couldn't remove unspoken reply");
						let t = A.channels.window(P).rows, n = t.slice(t.findIndex((e) => e.id === a) + 1).filter((e) => e.audience !== "agents" && !R.has(e.id)).slice(-10).map((e) => `${A.names?.resolve(e.authorId) || s.find(e.authorId)?.name || e.authorId}: ${e.content}`);
						Ee(e, `(Your reply ${a} was not spoken because newer input arrived first, so they never heard it. Use your judgement: if your reply still answers them, as when they were talking to someone else, send it again; otherwise drop it.)${n.length ? `\n\nSaid since:\n${n.join("\n")}` : ""}`, [e]);
					}
					if (i.status === "interrupted" && a && u.editOwnedAgent) {
						let e = i.estimatedSpokenText ?? "";
						await b(y ? l(v, e) : e, y ? "Couldn't strike through interrupted reply" : "Couldn't trim interrupted reply");
					}
					i.status === "interrupted" && Ee(e, w(i.estimatedSpokenText ?? ""), C);
				};
				Ae = Ae.then(async () => {
					if (!H || L) return;
					let t = await Pe(e);
					if (H && !L) return f = Date.now(), D(n, "speak", [
						...u ? ["--re", String(u)] : [],
						...t,
						o
					]);
				}).then(async (e) => {
					if (!e || !H || L) return;
					let t = JSON.parse(e);
					return t.status === "accepted" && typeof t.requestId == "number" && ke.set(t.requestId, async (e) => {
						if (e.status !== "failed") return g(e);
						if (p?.(), !(e.message ?? "").endsWith("voice session restarted")) throw Error(e.message);
					}), g(t);
				}).catch((e) => {
					!L && !T(e).endsWith("voice session restarted") && j({
						..._,
						error: `Couldn't speak reply: ${T(e)}`
					});
				});
			}
		}, Ie = (e, t, n) => L || e !== P || !(oe.has(t) || s.find(t)) || le.has(n) ? !1 : (le.add(n), !0), Le = A.subscribeIncoming((e) => {
			for (let { channelId: t, authorId: n, messageId: r, previewContent: i, createdAt: a, audience: o } of e) if (o !== "agents" && Ie(t, n, r)) {
				let e = A.channels.window(P).rows.find((e) => e.id === r);
				R.set(r, e?.createdAtMs ?? R.get(r) ?? a * 1e3), Fe(n, i, a, r);
			}
		}), Re = A.subscribeLive?.(({ channelId: e, events: t }) => {
			for (let { id: n, pubkey: r, kind: i, content: a, tags: o, created_at: c } of t) {
				let t = (e, t) => o.some((n) => n[0] === e && n[1] === t), l = e ?? o.find(([e]) => e === "h")?.[1];
				if (i === 9 && l === P && !t("audience", "agents")) {
					let e = o.find(([e]) => e === "ms")?.[1], t = c * 1e3 + (e && /^(0|[1-9]\d{0,2})$/.test(e) ? Number(e) : 0);
					if (s.find(r)) {
						Ie(l, r, n) && (R.set(n, t), Fe(r, a, c, n));
						continue;
					}
					we(n, t, r, o.filter(([e]) => e === "p").map((e) => e[1]));
				}
			}
		}), ze, Be, Ve, He = 0, Ue = Date.now(), We = !1, Ge = () => {
			We || (We = !0, q.kill().catch((e) => j({
				channelId: P,
				error: `Couldn't stop call: ${T(e)}`
			})));
		};
		v = () => {
			v = () => {}, L = !0, (_.inputActive || _.interim) && j({
				..._,
				inputActive: !1,
				inputSpeaking: void 0,
				interim: void 0
			}), clearTimeout(Be), D(n, "stop", [], x).catch(Ge), ze = setTimeout(Ge, b);
		};
		let Ke = async () => {
			if (!H || L) return;
			let e = _.status === "live" || Date.now() - Ue >= 15e3;
			try {
				if (JSON.parse(await D(n, "status", [], x)), !H || L) return;
				He = 0, _.status === "starting" && j({
					..._,
					status: "live"
				}), he();
			} catch (t) {
				if (!H || L) return;
				if (e && ++He >= 2) {
					Ve = `Call service stopped responding: ${T(t)}`, v(), H = !1, j({
						channelId: P,
						error: Ve
					});
					return;
				}
			}
			H && !L && (Be = setTimeout(Ke, b));
		};
		Be = setTimeout(Ke, b), L && v(), q.exited.then((e) => {
			clearTimeout(ze), clearTimeout(Be), Le(), Re?.(), Me(), H = !1;
			for (let e of ve.keys()) s.note?.(e, P, ee);
			v = () => {}, S = async () => {}, k = () => {};
			let t = je.trim().split("\n"), [n, r] = t.slice(-2), i = r?.startsWith("berd-call start failed:") ? `${r} (${n})` : r ?? n, a = t.reverse().find((e) => e.startsWith("berd-call: PCM overflow "));
			a && !i?.includes(a) && (i = `${i}\n${a}`), N = !1, j(Ve ? {
				channelId: P,
				error: Ve
			} : e ? {
				channelId: P,
				error: i || `berd-call exited with ${e}`
			} : {}), I();
		});
	}
	async function F(e) {
		if (_.status !== "live") return oe(n, ["--restart", ...e]);
		await S(() => D(n, "settings", [
			"--restart",
			...e,
			...O
		]));
	}
	return {
		snapshot: () => _,
		subscribe(e) {
			return A.add(e), () => void A.delete(e);
		},
		start: ae,
		stop: () => {
			++re, v();
		},
		end: () => (++re, v(), M),
		busy: () => N || ne > 0,
		targets: () => C,
		aim: (e, t) => k(e, t),
		async reset() {
			let e = _.status === "live" ? JSON.parse(await D(n, "status")).session?.tts : L(await ie(n));
			await F(await P(n, e?.backend === "siri" ? e : void 0));
		},
		restart: F,
		fail(e, t) {
			_.status || j({
				channelId: e,
				error: t
			});
		}
	};
}
//#endregion
//#region src/call-tools.ts
function R(e, t) {
	let n = () => {
		let e = t.snapshot();
		return {
			...e,
			status: e.status ?? "idle",
			agents: e.status ? t.targets() : []
		};
	};
	e.agents.addTool({
		name: "berd_call_start",
		description: "Start a voice call with the user in a Solo channel, or transfer the current call there. Ends the previous call before starting the destination and opens that conversation. Uses the saved voice and microphone settings. Pass a channel ID or exact name; defaults to this conversation. Optionally choose agent pubkeys already in the destination. A starting result means the call is launching; use berd_call_status to check readiness or errors. This opens the user’s microphone: use only when the user requests a call or transfer.",
		inputSchema: {
			type: "object",
			properties: {
				channel: {
					type: "string",
					description: "Destination Solo channel ID or exact name. Defaults to this conversation."
				},
				agents: {
					type: "array",
					minItems: 1,
					uniqueItems: !0,
					items: { type: "string" },
					description: "Agent pubkeys to talk to, all already members of the destination. Defaults to the destination’s conversation agent, or you if no conversation agent is known."
				}
			},
			additionalProperties: !1
		},
		async call(r, i, a) {
			if (Object.keys(a).some((e) => !["channel", "agents"].includes(e))) throw Error("Unknown call argument.");
			let o = a.channel === void 0 ? i.channel : a.channel;
			if (typeof o != "string" || !o.trim()) throw Error("Specify a Solo channel ID or exact name.");
			let s = e.relay.snapshot();
			if (s.status !== "ready" || s.cached || !s.viewer || !s.origin) throw Error("Connect to the community before starting a call.");
			let { session: c } = s;
			c.channels.ensureList();
			let l = c.channels.list();
			if (l.status !== "ready") throw Error("Channels are still loading. Try again once they have loaded.");
			let u = l.channels.filter((e) => e.name.toLowerCase() === o.trim().toLowerCase()), d = l.channels.find((e) => e.id === o.trim()) ?? (u.length === 1 ? u[0] : void 0);
			if (!d) throw Error(u.length > 1 ? "That channel name is ambiguous. Use its ID." : "No accessible channel matches that ID or name.");
			if (!["solo", "session"].includes(d.channelType ?? "") || d.archived || d.readOnly || d.cached || !d.members?.includes(s.viewer)) throw Error("Choose an active Solo channel you belong to.");
			let f = e.agents.snapshot();
			if (f.status !== "ready") throw Error("Agents are still loading. Try again once they have loaded.");
			let p = f.agents.filter((e) => d.members.includes(e.pubkey)), m = S(e.agents, d.id, d.members), h = p.find((e) => e.pubkey === m)?.pubkey ?? p.find((e) => e.pubkey === r.pubkey)?.pubkey ?? (p.length === 1 ? p[0].pubkey : void 0), g = a.agents === void 0 ? [h] : a.agents;
			if (!Array.isArray(g) || !g.length || g.some((e) => typeof e != "string" || !d.members.includes(e) || !f.agents.some((t) => t.pubkey === e))) throw Error("Choose agents already in the destination Solo channel.");
			await t.start(c, d.id, [...new Set(g)], C(e.agents, d.id));
			let _ = t.snapshot();
			if (_.channelId !== d.id || !_.status) throw Error(_.error ?? "Call start was superseded or cancelled.");
			a.agents !== void 0 && t.aim(d.id, [...new Set(g)]);
			let v = await e.navigation.open({
				version: 1,
				kind: "conversation",
				scope: {
					viewer: s.viewer,
					communityOrigin: s.origin
				},
				channelId: d.id
			}).catch(() => ({ status: "failed" }));
			return JSON.stringify({
				...n(),
				...v.status === "opened" ? {} : { warning: "The call started, but Buzz could not open its conversation." }
			});
		}
	}), e.agents.addTool({
		name: "berd_call_stop",
		description: "End the user’s current Berd Call, regardless of which channel it is in. Waits for the call process to exit. Does nothing if no call is active. Use when the user asks to end the call.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: !1
		},
		async call(e, r, i) {
			if (Object.keys(i).length) throw Error("Stop takes no arguments.");
			return await t.end(), JSON.stringify(n());
		}
	}), e.agents.addTool({
		name: "berd_call_status",
		description: "Read the user’s current Berd Call channel, starting/live/idle state, recipients and any error, without changing the call.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: !1
		},
		async call(e, t, r) {
			if (Object.keys(r).length) throw Error("Status takes no arguments.");
			return JSON.stringify(n());
		}
	});
}
//#endregion
//#region src/corrections.ts
var z = (e) => e.trim().replace(/\s+/gu, " ").toLowerCase(), ue = (e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/gu, "\\s+");
function de(e) {
	let t = /* @__PURE__ */ new Map();
	for (let n of e.split("\n").filter((e) => e.trim())) {
		let e = n.split("=").map((e) => e.trim().replace(/\s+/gu, " "));
		if (e.length !== 2 || e.some((e) => !e || e.length > 256)) throw Error("Use one heard = replacement pair per line, up to 256 characters per phrase.");
		let [r, i] = e, a = z(r);
		if (t.has(a)) throw Error(`Duplicate correction: ${r}`);
		if (t.set(a, i), t.size > 100) throw Error("Use at most 100 corrections.");
	}
	let n = t.size ? RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${[...t.keys()].sort((e, t) => t.length - e.length).map(ue).join("|")})(?![\\p{L}\\p{M}\\p{N}_])`, "giu") : void 0;
	return (e) => n ? e.replace(n, (e) => t.get(z(e)) ?? e) : e;
}
function fe(e) {
	let t = "berd-call.corrections", n = e.getItem(t) ?? "", r = (e) => e;
	try {
		r = de(n);
	} catch {}
	let i = /* @__PURE__ */ new Set();
	return {
		get: () => n,
		apply: (e) => r(e),
		set(a) {
			let o = de(a);
			e.setItem(t, a), n = a, r = o, i.forEach((e) => e());
		},
		subscribe(e) {
			return i.add(e), () => void i.delete(e);
		}
	};
}
//#endregion
//#region src/correction-tools.ts
var B = (e) => e.trim().replace(/\s+/gu, " ").toLowerCase(), V = (e, t) => {
	if (typeof e != "string" || !e.trim() || e.trim().length > 256 || /[=\r\n]/u.test(e)) throw Error(`${t} must be a single phrase of 1–256 characters, without = or line breaks.`);
	return e.trim().replace(/\s+/gu, " ");
};
function H(e, t) {
	e.addTool({
		name: "berd_call_corrections",
		description: "Read or change this device’s Berd Call transcription corrections. List returns saved heard = replacement rules. Set adds or updates one whole phrase, matching case-insensitively; remove deletes one. Other rules are preserved. Changes apply to the next utterance, including during an active call.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"set",
						"remove"
					],
					description: "Defaults to list."
				},
				heard: {
					type: "string",
					description: "The misheard phrase, required for set and remove."
				},
				replacement: {
					type: "string",
					description: "Exact replacement text, required for set."
				}
			},
			additionalProperties: !1
		},
		async call(e, n, r) {
			if (Object.keys(r).some((e) => ![
				"action",
				"heard",
				"replacement"
			].includes(e))) throw Error("Unknown correction argument.");
			let i = r.action ?? "list";
			if (![
				"list",
				"set",
				"remove"
			].includes(i)) throw Error("action must be list, set or remove.");
			if (i === "list") {
				if (r.heard !== void 0 || r.replacement !== void 0) throw Error("Use set or remove to change a correction.");
			} else {
				let e = V(r.heard, "heard");
				if (i === "remove" && r.replacement !== void 0) throw Error("remove does not take replacement.");
				let n = i === "set" ? V(r.replacement, "replacement") : void 0, a = t.get().split("\n").filter((e) => e.trim()), o = (t) => B(t.split("=")[0]) === B(e), s = a.filter((e) => !o(e));
				n !== void 0 && s.push(`${e} = ${n}`), t.set(s.join("\n"));
			}
			return JSON.stringify({
				corrections: t.get(),
				appliesTo: "next utterance"
			});
		}
	});
}
//#endregion
//#region src/agent-voices.ts
function pe(e) {
	let t = "berd-call.agent-voices", n = {};
	try {
		let r = JSON.parse(e.getItem(t) ?? "{}");
		r && typeof r == "object" && !Array.isArray(r) && (n = Object.fromEntries(Object.entries(r).flatMap(([e, t]) => t && typeof t == "object" && !Array.isArray(t) ? [[e, Object.fromEntries(Object.entries(t).filter(([, e]) => typeof e == "string"))]] : [])));
	} catch {}
	let r = /* @__PURE__ */ new Set(), i = (i) => {
		e.setItem(t, JSON.stringify(i)), n = i, r.forEach((e) => e());
	};
	return {
		get: () => n,
		set(e, t, r) {
			let a = { ...n[e] };
			r ? a[t] = r : delete a[t], i({
				...n,
				[e]: a
			});
		},
		remove(e) {
			let t = { ...n };
			delete t[e], i(t);
		},
		subscribe(e) {
			return r.add(e), () => void r.delete(e);
		}
	};
}
//#endregion
//#region src/credentials.ts
async function me(e, t, n) {
	let r = (await E(e, "credentials", [
		"status",
		await _(t, n),
		t.toUpperCase()
	])).trim();
	if ([
		"saved",
		"environment",
		"missing",
		"unreadable"
	].includes(r)) return r;
	throw Error("Could not check the API key.");
}
async function he(e, t, n, r) {
	if (!(n === f[t] ? /^sk-[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9_.~+/=:-]+$/).test(r)) throw Error(n === f[t] ? "Enter an OpenAI API key beginning with sk-." : "Enter the API key without spaces or quotes.");
	let i = await e.spawn("credentials", { args: [
		"save",
		await _(t, n),
		t.toUpperCase()
	] });
	if (await i.end(`${r}\n`), await i.exited !== 0) throw Error("Could not save the API key in Keychain. Unlock Keychain and try again.");
}
async function ge(e, t, n) {
	try {
		await E(e, "credentials", [
			"remove",
			await _(t, n),
			t.toUpperCase()
		]);
	} catch {
		throw Error("Could not remove the API key from Keychain.");
	}
}
//#endregion
//#region src/settings.tsx
var _e = [
	.5,
	.75,
	1,
	1.25,
	1.5,
	1.75,
	2
], ve = [
	"alloy",
	"ash",
	"ballad",
	"cedar",
	"coral",
	"echo",
	"fable",
	"marin",
	"nova",
	"onyx",
	"sage",
	"shimmer",
	"verse"
], ye = /* @__PURE__ */ new Map(), be = () => () => {}, xe = () => void 0, Se = (e) => Object.entries(e), U = (e) => e ? Math.round(e / 1e5) / 10 : void 0, Ce = ({ name: e, displayName: t }) => t || e, we = [
	["off", "Off"],
	["working", "While working"],
	["working-and-waiting", "While working and waiting"]
];
function W(e, t, n, r, i, a, o, s, c, l, u) {
	let { useEffect: d, useRef: h, useState: _, useSyncExternalStore: v } = e;
	function y({ title: t, subtitle: n, avatar: r, children: i }) {
		return /* @__PURE__ */ e.createElement("div", {
			"data-buzz-ui": "",
			className: "buzz-preference-row",
			"data-has-icon": r ? !0 : void 0
		}, r, /* @__PURE__ */ e.createElement("div", { className: "buzz-preference-row-content" }, /* @__PURE__ */ e.createElement("span", { className: "buzz-preference-row-label" }, t), n && /* @__PURE__ */ e.createElement("span", { className: "buzz-preference-row-description" }, n)), i && /* @__PURE__ */ e.createElement("div", { className: "buzz-preference-row-trailing" }, i));
	}
	function b({ label: t, value: n, options: r, onChange: i }) {
		return /* @__PURE__ */ e.createElement("select", {
			"data-buzz-ui": "",
			className: "buzz-input",
			"aria-label": t,
			value: n,
			onChange: (e) => i(e.target.value)
		}, [...new Set(r.map(([, , e]) => e))].map((t) => {
			let n = r.filter((e) => e[2] === t).map(([t, n]) => /* @__PURE__ */ e.createElement("option", {
				key: t,
				value: t
			}, n));
			return t ? /* @__PURE__ */ e.createElement("optgroup", {
				key: t,
				label: t
			}, n) : n;
		}));
	}
	function x({ children: t, feedback: n }) {
		let [r, i] = _(!1), a = h(null);
		return /* @__PURE__ */ e.createElement(e.Fragment, null, /* @__PURE__ */ e.createElement(y, {
			title: "Voice activity detection",
			subtitle: "Adjust when agents wait for you or respond to interruptions."
		}, /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-button",
			"aria-haspopup": "dialog",
			onClick: () => {
				a.current?.showModal(), i(!0);
			}
		}, "Configure VAD")), /* @__PURE__ */ e.createElement("style", null, ".berd-vad-dialog::backdrop { background: var(--bg-scrim, rgba(0,0,0,.45)); }"), /* @__PURE__ */ e.createElement("dialog", {
			ref: a,
			onClose: () => i(!1),
			onCancel: () => i(!1),
			className: "berd-vad-dialog",
			"data-buzz-ui": "",
			"aria-label": "Voice activity detection",
			style: {
				position: "fixed",
				inset: 0,
				margin: "auto",
				width: "min(640px, calc(100vw - 32px))",
				maxHeight: "calc(100dvh - 48px)",
				overflow: "auto",
				boxSizing: "border-box",
				background: "var(--surface-popover, #fff)",
				color: "var(--text-standard, #222)",
				border: "1px solid var(--border-standard, #ccc)",
				borderRadius: 12,
				padding: 24
			}
		}, /* @__PURE__ */ e.createElement("h3", { style: { marginTop: 0 } }, "Voice activity detection"), /* @__PURE__ */ e.createElement("p", null, "Changes are saved automatically for this audio setup. Changes during a call restart its session."), r && n, t, /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-button",
			onClick: () => {
				a.current?.close(), i(!1);
			}
		}, "Close")));
	}
	function S({ label: t, value: n, choices: r, language: i, activity: a, playing: o, failure: s, onBrowse: c, onPreview: l, onChange: u }) {
		let [f, p] = _(!1), [m, g] = _(i ?? ""), [v, y] = _(""), x = h(null), S = new Intl.DisplayNames([navigator.language], { type: "language" }), w = (e) => {
			try {
				return S.of(e) ?? e;
			} catch {
				return e;
			}
		}, T = [...new Set(r.map(([e]) => e.split("	")[1]).filter(Boolean))].sort((e, t) => w(e).localeCompare(w(t)));
		d(() => {
			f && x.current?.showModal();
		}, [f]);
		let E = r.find(([e]) => e === n), te = r.filter(([e]) => e.endsWith(`\t${m}`)).map(([e, t, n, r]) => [
			e,
			n ? t.slice(0, t.lastIndexOf(" (")) : t.replace(` (${m})`, ""),
			n,
			r
		]), D = () => {
			x.current?.close(), p(!1);
		}, O = (e) => {
			c(), u(e);
		};
		return T.length ? /* @__PURE__ */ e.createElement(e.Fragment, null, /* @__PURE__ */ e.createElement("style", null, ".berd-voice-dialog select { width: 100%; min-width: 0; } .berd-voice-dialog::backdrop { background: var(--bg-scrim, rgba(0,0,0,.45)); } .berd-voice { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 8px 0 12px; border-top: 1px solid var(--border-standard, #0001); } .berd-voice:first-child { border-top: 0; } .berd-voice-name { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; padding: 6px 0; background: none; border: 0; color: inherit; font: inherit; text-align: left; } button.berd-voice-name { cursor: pointer; } .berd-voice-name small { color: var(--text-subtle, #666); font-size: 12px; }"), /* @__PURE__ */ e.createElement("button", {
			type: "button",
			className: "buzz-button",
			"data-buzz-ui": "",
			"data-variant": "ghost",
			"aria-label": `Choose ${t}`,
			"aria-haspopup": "dialog",
			onClick: () => {
				c(), g(n.split("	")[1] || i || T[0] || ""), p(!0);
			}
		}, E?.[1] ?? (n || "Default voice")), f && /* @__PURE__ */ e.createElement("dialog", {
			className: "berd-voice-dialog",
			"data-buzz-ui": "",
			ref: x,
			"aria-label": `Choose ${t}`,
			onCancel: () => p(!1),
			onClose: () => p(!1),
			style: {
				position: "fixed",
				inset: 0,
				margin: "auto",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				gap: 12,
				width: "min(440px, calc(100vw - 32px))",
				maxHeight: "calc(100dvh - 48px)",
				overflow: "hidden",
				background: "var(--surface-popover, #fff)",
				color: "var(--text-standard, #222)",
				border: "1px solid var(--border-standard, #ccc)",
				borderRadius: 12,
				padding: 20,
				boxShadow: "0 16px 48px #0004"
			}
		}, /* @__PURE__ */ e.createElement("div", { style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between"
		} }, /* @__PURE__ */ e.createElement("h3", { style: {
			fontSize: 18,
			fontWeight: 600,
			margin: 0
		} }, "Choose ", t), /* @__PURE__ */ e.createElement("button", {
			type: "button",
			className: "buzz-button",
			"data-buzz-ui": "",
			"data-variant": "ghost",
			"data-size": "sm",
			"aria-label": "Close",
			onClick: D
		}, /* @__PURE__ */ e.createElement(C, { d: "M18 6 6 18M6 6l12 12" }))), /* @__PURE__ */ e.createElement(b, {
			label: "Language and region",
			value: m,
			options: T.map((e) => [e, w(e)]),
			onChange: (e) => {
				c(), g(e);
			}
		}), /* @__PURE__ */ e.createElement("div", {
			role: "list",
			"aria-label": `Browse ${t}`,
			style: {
				flex: "0 1 auto",
				minHeight: 0,
				overflow: "auto",
				border: "1px solid var(--border-standard, #0002)",
				borderRadius: 8
			}
		}, te.map(([t, r, i, s]) => {
			let c = s ? `${s} MB` : "", u = /* @__PURE__ */ e.createElement(e.Fragment, null, /* @__PURE__ */ e.createElement("span", null, r), /* @__PURE__ */ e.createElement("small", null, i ? c : [c, "Installed"].filter(Boolean).join(" · ")));
			return /* @__PURE__ */ e.createElement("div", {
				key: t,
				role: "listitem",
				className: "berd-voice",
				"data-selected": t === n || void 0
			}, i ? /* @__PURE__ */ e.createElement("div", { className: "berd-voice-name" }, u) : /* @__PURE__ */ e.createElement("button", {
				type: "button",
				className: "berd-voice-name",
				"aria-label": t === n ? `Selected voice: ${r}` : `Use ${r}`,
				"aria-pressed": t === n,
				disabled: !!a,
				onClick: () => O(t)
			}, u), t === n && /* @__PURE__ */ e.createElement("span", { style: {
				color: "var(--text-accent, #0a84ff)",
				display: "flex"
			} }, /* @__PURE__ */ e.createElement(C, { d: "M20 6 9 17l-5-5" })), i && /* @__PURE__ */ e.createElement("button", {
				type: "button",
				className: "buzz-button",
				"data-buzz-ui": "",
				"data-variant": "ghost",
				"data-size": "sm",
				"aria-label": `Download ${r}`,
				title: `Download ${r}`,
				disabled: !!a,
				onClick: () => O(t)
			}, /* @__PURE__ */ e.createElement(C, { d: "M12 13v8m-4-4 4 4 4-4M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" })), l && /* @__PURE__ */ e.createElement(ee, {
				label: r,
				playing: !!o && v === t,
				onClick: () => {
					y(t), l(t);
				}
			}));
		})), (a || s) && /* @__PURE__ */ e.createElement("div", null, a && /* @__PURE__ */ e.createElement("div", { "aria-live": "polite" }, a), s && /* @__PURE__ */ e.createElement("p", {
			role: "alert",
			style: { margin: 0 }
		}, s)), r.some(([e]) => !e) && /* @__PURE__ */ e.createElement("div", null, /* @__PURE__ */ e.createElement("button", {
			type: "button",
			className: "buzz-button",
			"data-buzz-ui": "",
			disabled: !!a || !n,
			onClick: () => {
				O(""), D();
			}
		}, "Use default voice")))) : /* @__PURE__ */ e.createElement(b, {
			label: t,
			value: n,
			options: r,
			onChange: u
		});
	}
	function C({ d: t }) {
		return /* @__PURE__ */ e.createElement("svg", {
			width: 16,
			height: 16,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true"
		}, /* @__PURE__ */ e.createElement("path", { d: t }));
	}
	function ee({ label: t, playing: n, onClick: r }) {
		return /* @__PURE__ */ e.createElement("button", {
			type: "button",
			className: "buzz-button",
			"data-buzz-ui": "",
			"data-variant": "ghost",
			"data-size": "sm",
			"aria-label": `${n ? "Stop" : "Preview"} ${t}`,
			onClick: r
		}, /* @__PURE__ */ e.createElement(C, { d: n ? "M7 7h10v10H7z" : "M8 5l11 7l-11 7z" }));
	}
	function w({ label: t, checked: n, disabled: r, onChange: i }) {
		return /* @__PURE__ */ e.createElement("input", {
			type: "checkbox",
			"aria-label": t,
			checked: n,
			disabled: r,
			onChange: (e) => i(e.target.checked)
		});
	}
	function T({ label: t, value: n, min: r, max: i, step: a, empty: o, placeholder: s, onChange: c }) {
		return /* @__PURE__ */ e.createElement("input", {
			key: String(n),
			"data-buzz-ui": "",
			className: "buzz-input",
			type: "number",
			"aria-label": t,
			min: r,
			max: i,
			step: a,
			placeholder: s,
			defaultValue: n ?? "",
			onBlur: (e) => {
				let t = e.target.value.trim(), a = Number(t);
				c(t && Number.isFinite(a) ? Math.min(i, Math.max(r, Math.round(a))) : o), e.target.value = String(n ?? "");
			}
		});
	}
	function te({ name: t, picture: n, size: r = 32 }) {
		let [i, a] = _(!1), [o, s] = _(!1);
		return /* @__PURE__ */ e.createElement("span", {
			"data-buzz-ui": "",
			className: "buzz-avatar",
			"data-size": "default",
			"data-avatar-shape": "squircle",
			style: {
				width: r,
				height: r,
				flexShrink: 0
			}
		}, n && !o && /* @__PURE__ */ e.createElement("img", {
			src: n,
			alt: `${t} avatar`,
			referrerPolicy: "no-referrer",
			"data-loaded": i ? "true" : void 0,
			onLoad: () => a(!0),
			onError: () => s(!0)
		}), !i && /* @__PURE__ */ e.createElement("span", { "aria-hidden": "true" }, Array.from(t.trim())[0]?.toUpperCase() || "?"));
	}
	function j({ label: t, agents: n, onPick: r }) {
		let [i, a] = _(!1), [o, s] = _(""), [c, l] = _(0), u = h(null);
		d(() => {
			if (!i) return;
			let e = (e) => {
				u.current?.contains(e.target) || a(!1);
			};
			return document.addEventListener("pointerdown", e), () => document.removeEventListener("pointerdown", e);
		}, [i]);
		let f = n.filter((e) => e.name.toLowerCase().includes(o.trim().toLowerCase())), p = (e) => {
			a(!1), s(""), l(0), r(e);
		};
		return /* @__PURE__ */ e.createElement("span", {
			ref: u,
			style: {
				position: "relative",
				display: "block"
			}
		}, /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-preference-row",
			"data-has-icon": "",
			"aria-expanded": i,
			onClick: () => a(!i),
			style: {
				width: "100%",
				background: "none",
				border: 0,
				color: "inherit",
				font: "inherit",
				textAlign: "left",
				cursor: "pointer"
			}
		}, /* @__PURE__ */ e.createElement("span", { style: {
			display: "flex",
			justifyContent: "center",
			width: 28
		} }, /* @__PURE__ */ e.createElement(C, { d: "M12 5v14M5 12h14" })), /* @__PURE__ */ e.createElement("span", { className: "buzz-preference-row-content" }, /* @__PURE__ */ e.createElement("span", { className: "buzz-preference-row-label" }, t))), i && /* @__PURE__ */ e.createElement("div", {
			role: "dialog",
			"aria-label": "Choose an agent",
			"data-buzz-ui": "",
			className: "buzz-menu-popup text-body-sm",
			style: {
				position: "absolute",
				top: "100%",
				left: 0,
				marginTop: 4,
				zIndex: 10
			}
		}, /* @__PURE__ */ e.createElement("input", {
			autoFocus: !0,
			"data-buzz-ui": "",
			className: "buzz-input",
			"aria-label": "Search agents",
			placeholder: "Search agents",
			value: o,
			style: {
				width: "100%",
				marginBottom: 4
			},
			onChange: (e) => {
				s(e.target.value), l(0);
			},
			onKeyDown: (e) => {
				e.key === "Escape" ? a(!1) : e.key === "ArrowDown" || e.key === "ArrowUp" ? (e.preventDefault(), l((c + (e.key === "ArrowDown" ? 1 : f.length - 1)) % Math.max(1, f.length))) : e.key === "Enter" && f[c] && (e.preventDefault(), p(f[c].pubkey));
			}
		}), /* @__PURE__ */ e.createElement("div", {
			role: "listbox",
			"aria-label": "Agents"
		}, f.map((t, n) => /* @__PURE__ */ e.createElement("div", {
			key: t.pubkey,
			role: "option",
			"aria-selected": n === c,
			"data-buzz-ui": "",
			className: "buzz-menu-item",
			"data-highlighted": n === c ? "" : void 0,
			onPointerEnter: () => l(n),
			onClick: () => p(t.pubkey)
		}, /* @__PURE__ */ e.createElement(te, {
			key: t.picture,
			name: t.name,
			picture: t.picture,
			size: 20
		}), t.name)), !f.length && /* @__PURE__ */ e.createElement("div", { className: "buzz-menu-note" }, "No agents match."))));
	}
	function M({ title: t, children: n }) {
		return /* @__PURE__ */ e.createElement("section", {
			"aria-label": t,
			className: "buzz-settings-group",
			"data-layout": "rows",
			style: { marginBottom: 28 }
		}, /* @__PURE__ */ e.createElement("h3", { style: {
			margin: "24px 0 4px",
			fontSize: "var(--font-size-sm, 14px)"
		} }, t), n);
	}
	function ne({ kind: t, status: n, url: r, live: i, busy: a, onSave: o, onRemove: s }) {
		let c = m[t], l = r === f[t] ? "" : r, [u, p] = _(l), [h, g] = _("");
		d(() => p(l), [l]);
		let v = i || a, y = u.trim() !== l, b = {
			display: "flex",
			flexDirection: "column",
			gap: 4
		}, x = {
			margin: 0,
			fontSize: 13
		};
		return /* @__PURE__ */ e.createElement("form", {
			style: {
				...b,
				alignItems: "flex-start",
				gap: 12,
				padding: "12px 0"
			},
			onSubmit: (e) => {
				e.preventDefault(), !v && (y || h.trim()) && o(u, h.trim()).then((e) => e && g(""));
			}
		}, /* @__PURE__ */ e.createElement("label", { style: b }, c, " URL ", /* @__PURE__ */ e.createElement("input", {
			"data-buzz-ui": "",
			className: "buzz-input",
			"aria-label": `${c} URL`,
			type: "url",
			autoComplete: "off",
			spellCheck: !1,
			placeholder: f[t],
			value: u,
			disabled: v,
			onChange: (e) => p(e.target.value)
		})), /* @__PURE__ */ e.createElement("label", { style: b }, c, " API key ", /* @__PURE__ */ e.createElement("input", {
			"data-buzz-ui": "",
			className: "buzz-input",
			"aria-label": `${c} API key`,
			type: "password",
			autoComplete: "new-password",
			spellCheck: !1,
			placeholder: (n === "saved" || n === "environment") && !y ? "••••••••••••••••••••" : void 0,
			value: h,
			disabled: v,
			onChange: (e) => g(e.target.value)
		})), /* @__PURE__ */ e.createElement("div", { style: {
			display: "flex",
			gap: 8
		} }, /* @__PURE__ */ e.createElement("button", {
			type: "submit",
			"aria-label": `Save ${c}`,
			"data-buzz-ui": "",
			className: "buzz-button",
			"data-variant": "secondary",
			"data-size": "sm",
			disabled: v || !(y || h.trim())
		}, "Save"), (n === "saved" || n === "unreadable") && !y && /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"aria-label": `Remove ${c} key`,
			"data-buzz-ui": "",
			className: "buzz-button",
			"data-variant": "ghost",
			"data-size": "sm",
			disabled: v,
			onClick: s
		}, "Remove key")), /* @__PURE__ */ e.createElement("p", {
			role: "status",
			style: x
		}, y ? "Save to use this URL and check for its key." : n === "saved" ? "An API key is saved in macOS Keychain for this URL. It is read when a call starts." : n === "environment" ? "Using the API key from the Buzz process environment." : n === "unreadable" ? "Could not read Keychain. Unlock it or replace the saved key." : n === "missing" ? "No API key is saved for this URL." : "Checking for an API key…"), /* @__PURE__ */ e.createElement("p", { style: {
			...x,
			color: "var(--text-secondary)"
		} }, "Keys are kept in macOS Keychain, outside plugin preferences, one for each URL (Berd's default OpenAI URLs share one). Other programs with Keychain access can read them. ", i && "End the current call before changing a URL or key. The next call uses the new ones."));
	}
	function re({ dictionary: t }) {
		let n = v(t.subscribe, t.get), r = (e) => e.split("\n").filter((e) => e.trim()).map((e) => {
			let t = e.indexOf("=");
			return [e.slice(0, t).trim(), e.slice(t + 1).trim()];
		}), i = (e) => r(e).length ? r(e) : [["", ""]], a = (e) => e.filter((e) => e.some((e) => e.trim())).map((e) => e.map((e) => e.trim()).join(" = ")).join("\n"), [o, s] = _(() => i(n)), [c, l] = _(), u = h(n);
		d(() => {
			u.current !== n && (u.current = n, s(i(n)));
		}, [n]);
		let f = (e = o) => {
			if (e.some((e) => e.some((e) => e.trim()) && e.some((e) => !e.trim()))) return;
			let n = a(e);
			try {
				u.current = n, t.set(n), l(void 0);
			} catch (e) {
				u.current = t.get(), l(e.message);
			}
		}, p = (e, t, n) => {
			s((r) => r.map((r, i) => i === e ? r.map((e, r) => r === t ? n : e) : r)), l(void 0);
		};
		return /* @__PURE__ */ e.createElement("section", {
			"aria-label": "Transcription corrections",
			style: { marginBottom: "var(--space-8)" }
		}, /* @__PURE__ */ e.createElement("div", {
			className: "buzz-content-header",
			"data-inline": "",
			"data-buzz-ui": ""
		}, /* @__PURE__ */ e.createElement("div", { className: "buzz-content-header-copy" }, /* @__PURE__ */ e.createElement("h3", { className: "buzz-content-header-title" }, "Transcription corrections"), /* @__PURE__ */ e.createElement("p", { className: "buzz-content-header-subtitle" }, "Fix misheard words before posting and choosing recipients."))), /* @__PURE__ */ e.createElement("form", {
			className: "buzz-settings-group",
			"data-layout": "form",
			onSubmit: (e) => {
				e.preventDefault(), f();
			}
		}, /* @__PURE__ */ e.createElement("div", { style: {
			display: "grid",
			gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) var(--space-8)",
			gap: "var(--space-2)"
		} }, /* @__PURE__ */ e.createElement("span", {
			className: "text-label-sm",
			"aria-hidden": "true"
		}, "Heard"), /* @__PURE__ */ e.createElement("span", {
			className: "text-label-sm",
			"aria-hidden": "true"
		}, "Replace with"), /* @__PURE__ */ e.createElement("span", { "aria-hidden": "true" }), o.map((t, n) => /* @__PURE__ */ e.createElement("div", {
			key: n,
			role: "group",
			"aria-label": `Correction ${n + 1}`,
			style: {
				display: "grid",
				gridTemplateColumns: "subgrid",
				gridColumn: "1 / -1",
				alignItems: "center"
			}
		}, ["Heard", "Replace with"].map((r, i) => /* @__PURE__ */ e.createElement("input", {
			key: r,
			"aria-label": r,
			"data-buzz-ui": "",
			className: "buzz-input",
			style: {
				minWidth: 0,
				width: "100%"
			},
			maxLength: 256,
			spellCheck: !1,
			autoComplete: "off",
			autoCapitalize: "off",
			placeholder: i ? "Zack" : "Zach",
			value: t[i],
			onBlur: () => f(),
			onChange: (e) => p(n, i, e.target.value)
		})), /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-button",
			"data-variant": "ghost",
			"data-size": "sm",
			"data-button-shape": "control",
			"data-icon-variant": "ghost",
			"aria-label": `Remove correction ${n + 1}`,
			title: "Remove correction",
			onClick: () => {
				let e = o.filter((e, t) => t !== n);
				s(e), f(e);
			}
		}, /* @__PURE__ */ e.createElement("span", { className: "buzz-button-label" }, /* @__PURE__ */ e.createElement(C, { d: "M6 6l12 12M18 6L6 18" })))))), /* @__PURE__ */ e.createElement("p", {
			className: "text-caption text-subtle",
			style: { margin: 0 }
		}, "Matches ignore capitalization. Replacements keep the spelling you enter. Complete pairs save when you leave a field and apply to your next utterance."), c && /* @__PURE__ */ e.createElement("p", {
			role: "alert",
			className: "text-body-sm",
			style: {
				margin: 0,
				color: "var(--text-danger)"
			}
		}, c), /* @__PURE__ */ e.createElement("div", { style: {
			display: "flex",
			flexWrap: "wrap",
			justifyContent: "space-between",
			alignItems: "center",
			gap: "var(--space-2)"
		} }, /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-button",
			"data-variant": "ghost",
			"data-size": "sm",
			disabled: o.length >= 100,
			onClick: () => s((e) => [...e, ["", ""]])
		}, /* @__PURE__ */ e.createElement(C, { d: "M12 5v14M5 12h14" }), "Add correction"))));
	}
	function ae({ label: t, value: n, dynamic: r, supported: i, onChange: a }) {
		let [o, s] = _(n), [c, l] = _(!1);
		d(() => {
			c || s(n);
		}, [n, c]);
		let u = () => {
			c && o !== n && a(o, r), l(!1);
		};
		return /* @__PURE__ */ e.createElement("div", { style: {
			display: "grid",
			gap: 6,
			minWidth: 200
		} }, /* @__PURE__ */ e.createElement("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 8
		} }, /* @__PURE__ */ e.createElement("input", {
			type: "range",
			"aria-label": t,
			min: 0,
			max: 1,
			step: .01,
			value: o,
			onChange: (e) => {
				l(!0), s(Number(e.target.value));
			},
			onPointerUp: u,
			onKeyUp: u,
			onBlur: u
		}), /* @__PURE__ */ e.createElement("output", { "aria-label": `${t} current value` }, o.toFixed(2))), /* @__PURE__ */ e.createElement("label", { style: {
			display: "flex",
			alignItems: "center",
			gap: 6
		} }, /* @__PURE__ */ e.createElement("input", {
			type: "checkbox",
			"aria-label": `Dynamically adjust ${t.toLowerCase()}`,
			checked: r,
			disabled: !i,
			onChange: (e) => a(o, e.target.checked)
		}), "Dynamically adjust"));
	}
	function F() {
		let m = v(o?.subscribe ?? be, o?.snapshot ?? xe)?.session, F = v(m?.profiles.subscribe ?? be, m?.profiles.snapshot ?? xe), se = v(m?.agentChoices.subscribe ?? be, m?.agentChoices.snapshot ?? xe);
		d(() => m?.agentChoices.retain(), [m]);
		let ce = v(s?.subscribe ?? be, s?.get ?? (() => "names")), le = v(c?.subscribe ?? be, c?.get ?? (() => "strike")), R = v(u?.subscribe ?? be, u?.get ?? (() => !1)), z = v(i.subscribe, i.get), ue = v(r.subscribe, r.snapshot).agents, [de, fe] = _([]), B = [.../* @__PURE__ */ new Set([...Object.keys(z).filter((e) => Object.values(z[e]).some(Boolean)), ...de])].join(" ");
		d(() => {
			B && m?.profiles.ensure(B.split(" "), "background").catch(() => {});
		}, [m, B]);
		let V = v(n.subscribe, () => n.snapshot().status === "live"), [H, pe] = _(), [W, Te] = _(), [G, K] = _(), [Ee, De] = _(!1), [Oe, ke] = _(), [Ae, je] = _(0), [q, Me] = _(), [Ne, Pe] = _(), Fe = h(0), Ie = () => {
			Fe.current++, Pe(void 0), K(void 0), Re(void 0), Me(void 0);
		}, [Le, Re] = _();
		d(() => Le, [Le]);
		let ze = v(a.subscribe, a.get), [Be, Ve] = _({}), [He, Ue] = _(!1), We = () => Promise.all(p.map((e) => me(t, e, ze[e]).catch(() => "unreadable").then((t) => Ve((n) => ({
			...n,
			[e]: t
		})))));
		d(() => {
			We();
		}, [V, ze]);
		let Ge = async (e, n, r) => {
			Ue(!0), K(void 0);
			try {
				let i = n.trim() ? g(e, n) : f[e];
				r && await he(t, e, i, r), a.set(e, i), await We();
			} catch (e) {
				K(e.message);
				return;
			} finally {
				Ue(!1);
			}
			return !0;
		}, Ke = async (e) => {
			Ue(!0), K(void 0);
			try {
				await ge(t, e, ze[e]), await We();
			} catch (e) {
				K(e.message);
			} finally {
				Ue(!1);
			}
		}, qe = () => V ? D(t, "status").then(JSON.parse) : Promise.all([ie(t), E(t, "cli", ["detection-profile"]).then(JSON.parse).catch(() => void 0)]).then(([e, t]) => ({
			audioSetup: t?.audioSetup,
			session: {
				detection: t?.settings ? { settings: t.settings } : void 0,
				tts: L(e),
				input_during_tts: { policy: e.input_policy }
			},
			sessionArguments: e.arguments,
			statusSounds: e.status_sounds,
			vadDebugSounds: e.vad_debug_sounds
		})), Je = () => qe().then(pe);
		d(() => {
			Je().catch((e) => K(e.message));
			let e = setInterval(() => {
				Je().catch((e) => K(e.message));
			}, 2e3);
			return () => clearInterval(e);
		}, [V]);
		let J = H?.session?.tts?.backend;
		d(() => {
			let e = J === "siri" ? N(t).then((e) => [...e.filter((e) => e.installed).map((e) => [
				`${e.name}\t${e.language}`,
				`${Ce(e)} (${e.language})`,
				void 0,
				U(e.sizeBytes)
			]), ...e.filter((e) => !e.installed && e.sizeBytes).map((e) => [
				`${e.name}\t${e.language}`,
				`${Ce(e)} (${U(e.sizeBytes)} MB)`,
				"Available to download",
				U(e.sizeBytes)
			])]) : J === "pocket" ? E(t, "pocket-voices").then((e) => JSON.parse(e).result.voices.map((e) => [e.id, e.name])) : Promise.resolve(ve.map((e) => [e, e[0].toUpperCase() + e.slice(1)]));
			Te(J ? ye.get(J) : void 0);
			let n = !0;
			return e.then((e) => {
				J && ye.set(J, e), n && Te(e);
			}, () => {
				n && Te([]);
			}), () => {
				n = !1;
			};
		}, [J, Ae]);
		let Y = (e) => (K(void 0), De(!0), e().then(Je).catch((e) => K(e.message)).finally(() => De(!1))), Ye = async (e) => {
			if (e[0] === "--vad-debug-sounds" && !(await E(t, "settings", ["--help"])).includes("--vad-debug-sounds")) throw Error("Update berd-call to use VAD debug sounds.");
			return V ? D(t, "settings", e) : oe(t, e);
		}, Xe = (e) => Y(() => Ye(e)), Ze = (e, n, r, i = !1) => {
			let [, a] = W?.find(([e, , t]) => e === n && t) ?? [];
			if (!a) return i ? Y(async () => r(n)) : r(n);
			let o = a.slice(0, a.lastIndexOf(" (")), [s, c] = n.split("	");
			return Y(async () => {
				ke({
					name: o,
					row: e
				});
				try {
					await E(t, "voices", [
						"download",
						"--voice",
						s,
						"--language",
						c
					]);
				} finally {
					ke(void 0);
				}
				je((e) => e + 1), await r(n);
			});
		}, Qe = (t) => Oe?.row === t ? /* @__PURE__ */ e.createElement("span", { role: "status" }, "Downloading ", Oe.name, "…") : void 0, $e = async (e, n) => {
			let r = ++Fe.current;
			if (Pe(void 0), Re(void 0), Me(void 0), q === e) return;
			let [i, a] = n.split("	"), o = "", s = await t.spawn("voices", {
				args: [
					"preview",
					"--voice",
					i,
					"--language",
					a,
					"--rate",
					String(X.rate ?? 1)
				],
				onStderr: (e) => void (o += e)
			}), c = () => void s.kill().catch(() => {});
			Me(e), Re(() => c), s.exited.then((t) => {
				r === Fe.current && (t && t !== 143 && r === Fe.current && Pe(/no system preview/i.test(o) ? W?.find(([e]) => e === n)?.[2] ? "No system preview is available. Download this voice to preview it." : "No preview is available for this voice." : o.trim().split("\n").at(-1) || `Could not preview ${i}.`), Re((e) => e === c ? void 0 : e), Me((t) => t === e ? void 0 : t));
			});
		}, X = H?.session?.tts ?? {}, Z = O(H?.sessionArguments), et = (e) => {
			let t = ue.find((t) => t.pubkey === e), n = se?.identities.find((t) => t.pubkey === e), r = F?.get(e)?.picture ?? t?.picture ?? n?.avatar;
			return {
				pubkey: e,
				name: t?.name ?? n?.name ?? e.slice(0, 12),
				picture: r?.startsWith("data:") ? r : r && m?.media(r, "small")
			};
		}, tt = (B ? B.split(" ") : []).map(et), nt = ue.filter((e) => !tt.some((t) => t.pubkey === e.pubkey)).map((e) => et(e.pubkey)).sort((e, t) => e.name.localeCompare(t.name)), Q = Z["--stt-backend"] ?? "macos", $ = J === "siri", rt = $ ? `${X.voice}\t${X.language}` : X.voice ?? "", it = $ ? .5 : .75, at = (e, t, n = A[e] ?? e) => t.some(([t]) => t === e) ? t : [[e, n], ...t], ot = (e) => Y(async () => {
			let r = e.tts ?? J, i = String(Math.max(X.rate ?? 1, r === "siri" ? .5 : .75)), a = r === "siri" ? [
				...(await P(t, $ ? X : void 0)).slice(2, 8),
				"--rate",
				i
			] : r === "pocket" ? [
				"--tts-backend",
				"pocket",
				"--model-dir",
				Z["--model-dir"],
				"--voice",
				X.voice,
				"--rate",
				i
			] : [
				"--tts-backend",
				"openai",
				"--rate",
				i
			], o = e.stt ?? Q, s = o === "parakeet" ? ["--stt-model-dir", Z["--stt-model-dir"]] : [], c = o !== "macos" && ("--dynamic-listening" in Z || "--dynamic-interruption" in Z) ? [
				"--dynamic-listening",
				"false",
				"--dynamic-interruption",
				"false"
			] : [];
			await n.restart(I(H?.sessionArguments ?? [], [
				"--stt-backend",
				o,
				...s,
				...a,
				...c
			])), r === "openai" && J === "openai" && X.voice && await Ye(["--voice", X.voice]);
		});
		return /* @__PURE__ */ e.createElement("div", { "data-buzz-ui": "" }, /* @__PURE__ */ e.createElement("p", { style: {
			color: "var(--text-secondary)",
			margin: "0 0 16px"
		} }, V ? "Changes apply to this call and are saved for future calls." : "Choose how your next call sounds. Changes are saved automatically."), Ee && !Oe && /* @__PURE__ */ e.createElement("p", { role: "status" }, "Applying changes… A live call may wait for the current reply to finish."), G && /* @__PURE__ */ e.createElement("p", {
			role: "alert",
			style: { color: "var(--text-danger)" }
		}, G), /* @__PURE__ */ e.createElement("fieldset", {
			disabled: Ee || He || !H,
			style: {
				border: 0,
				margin: 0,
				padding: 0,
				minWidth: 0
			}
		}, /* @__PURE__ */ e.createElement(M, { title: "Agent voices" }, /* @__PURE__ */ e.createElement(y, {
			title: "Voice provider",
			subtitle: "How agent replies are spoken."
		}, /* @__PURE__ */ e.createElement(b, {
			label: "Voice provider",
			value: J ?? "",
			options: at(J ?? "", Se(k.tts)),
			onChange: (e) => ot({ tts: e })
		})), J === "openai" && /* @__PURE__ */ e.createElement(ne, {
			kind: "tts",
			status: Be.tts,
			url: ze.tts,
			live: V,
			busy: He,
			onSave: (e, t) => Ge("tts", e, t),
			onRemove: () => void Ke("tts")
		}), /* @__PURE__ */ e.createElement(y, {
			title: "Speed",
			subtitle: "Applies to every agent voice, including individual choices below."
		}, /* @__PURE__ */ e.createElement(b, {
			label: "Speed",
			value: String(X.rate ?? 1),
			options: at(String(X.rate ?? 1), _e.filter((e) => e >= it).map((e) => [String(e), `${e}×`])),
			onChange: (e) => Xe(["--rate", e])
		})), /* @__PURE__ */ e.createElement(y, {
			title: "Default agent voice",
			subtitle: Qe("default") ?? "Used unless you choose an individual voice below."
		}, /* @__PURE__ */ e.createElement("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 8
		} }, /* @__PURE__ */ e.createElement(S, {
			activity: Qe("default"),
			playing: q === "default",
			failure: Ne ?? G,
			onBrowse: Ie,
			onPreview: $ ? (e) => $e("default", e) : void 0,
			label: "Default agent voice",
			value: rt,
			choices: at(rt, W ?? [], X.voice ?? "Unknown"),
			language: X.language,
			onChange: (e) => Ze("default", e, (e) => {
				let [t, n] = e.split("	");
				return Ye([
					"--voice",
					t,
					...n ? ["--language", n] : []
				]);
			}, !0)
		}), $ && /* @__PURE__ */ e.createElement(ee, {
			label: "default agent voice",
			playing: q === "default",
			onClick: () => $e("default", rt)
		}))), tt.map((t) => {
			let n = z[t.pubkey]?.[J ?? ""] ?? "";
			return /* @__PURE__ */ e.createElement(y, {
				key: t.pubkey,
				title: t.name,
				subtitle: Qe(t.pubkey),
				avatar: /* @__PURE__ */ e.createElement("span", { style: {
					display: "flex",
					alignItems: "center",
					gap: 4,
					flexShrink: 0
				} }, /* @__PURE__ */ e.createElement("button", {
					type: "button",
					className: "buzz-button",
					"data-buzz-ui": "",
					"data-variant": "ghost",
					"data-size": "sm",
					"aria-label": `Remove voice for ${t.name}`,
					onClick: () => {
						i.remove(t.pubkey), fe((e) => e.filter((e) => e !== t.pubkey));
					}
				}, /* @__PURE__ */ e.createElement(C, { d: "M6 6l12 12M18 6L6 18" })), /* @__PURE__ */ e.createElement(te, {
					key: t.picture,
					name: t.name,
					picture: t.picture
				}))
			}, /* @__PURE__ */ e.createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8
			} }, /* @__PURE__ */ e.createElement(S, {
				activity: Qe(t.pubkey),
				playing: q === t.pubkey,
				failure: Ne ?? G,
				onBrowse: Ie,
				onPreview: $ ? (e) => $e(t.pubkey, e) : void 0,
				label: `Voice for ${t.name}`,
				value: n,
				language: n.split("	")[1] || X.language,
				choices: [
					["", "Default voice"],
					...W ?? [],
					...n && !W?.some(([e]) => e === n) ? [[n, `${n.split("	")[0]}${W ? " (unavailable)" : ""}`]] : []
				],
				onChange: (e) => Ze(t.pubkey, e, (e) => {
					J && i.set(t.pubkey, J, e);
				})
			}), $ && /* @__PURE__ */ e.createElement(ee, {
				label: `voice for ${t.name}`,
				playing: q === t.pubkey,
				onClick: () => $e(t.pubkey, n || rt)
			})));
		}), nt.length > 0 && /* @__PURE__ */ e.createElement(j, {
			label: "Add a custom voice for an agent",
			agents: nt,
			onPick: (e) => fe((t) => [...t, e])
		})), /* @__PURE__ */ e.createElement(M, { title: "Microphone" }, /* @__PURE__ */ e.createElement(y, {
			title: "Speech recognition",
			subtitle: "Turns what you say into messages for your agents."
		}, /* @__PURE__ */ e.createElement(b, {
			label: "Speech recognition",
			value: Q,
			options: at(Q, Se(k.stt)),
			onChange: (e) => ot({ stt: e })
		})), Q === "openai" && /* @__PURE__ */ e.createElement(ne, {
			kind: "stt",
			status: Be.stt,
			url: ze.stt,
			live: V,
			busy: He,
			onSave: (e, t) => Ge("stt", e, t),
			onRemove: () => void Ke("stt")
		}), /* @__PURE__ */ e.createElement(y, {
			title: "Mute input while speaking",
			subtitle: "Auto mutes during speech on detected speakers and allows interruption on headphones. Follows output changes during a call."
		}, /* @__PURE__ */ e.createElement(b, {
			label: "Mute input while speaking",
			value: H?.session?.input_during_tts?.policy ?? "auto",
			options: [
				["suppress_input", "On"],
				["allow_barge_in", "Off"],
				["auto", "Auto"]
			],
			onChange: (e) => Xe(["--input-during-tts", e === "auto" ? "auto" : e === "suppress_input" ? "suppress" : "allow"])
		})), s && /* @__PURE__ */ e.createElement(y, {
			title: "Allow spoken name targeting",
			subtitle: "Say an agent's name to address them, or everyone to address all agents in this chat. Follow-ups stay with the conversation. Turn off to use the composer's recipients."
		}, /* @__PURE__ */ e.createElement(w, {
			label: "Allow spoken name targeting",
			checked: ce === "names",
			onChange: (e) => s.set(e ? "names" : "picker")
		})), /* @__PURE__ */ e.createElement(x, { feedback: /* @__PURE__ */ e.createElement(e.Fragment, null, Ee && /* @__PURE__ */ e.createElement("p", { role: "status" }, "Applying changes…"), G && /* @__PURE__ */ e.createElement("p", {
			role: "alert",
			style: { color: "var(--text-danger)" }
		}, G)) }, /* @__PURE__ */ e.createElement(y, {
			title: "Debug sounds",
			subtitle: "Play distinct clicks when speech detection starts and stops. Follows Mute input while speaking."
		}, /* @__PURE__ */ e.createElement(w, {
			label: "Debug sounds",
			checked: H?.vadDebugSounds === !0,
			onChange: (e) => Xe(["--vad-debug-sounds", e ? "on" : "off"])
		})), [[
			"Listening detection",
			"listening",
			"0.5",
			"Controls speech detection before replies start. Higher values reduce false detections that hold replies."
		], [
			"Interruption detection",
			"interruption",
			"0.65",
			"Controls speech detection during agent playback. Higher values make interruptions harder."
		]].map(([r, i, , a]) => {
			let o = H?.session?.detection?.settings ?? {
				listening: {
					value: Number(Z["--listening-threshold"] ?? .5),
					dynamic: Z["--dynamic-listening"] === "true"
				},
				interruption: {
					value: Number(Z["--interruption-threshold"] ?? .65),
					dynamic: Z["--dynamic-interruption"] === "true"
				}
			}, s = {
				...o[i],
				dynamic: Q === "macos" && o[i].dynamic
			};
			return /* @__PURE__ */ e.createElement(y, {
				key: i,
				title: r,
				subtitle: `${a} Changes restart the call session. Dynamic tuning is experimental and requires Apple speech recognition. Saved for this microphone and output setup.`
			}, /* @__PURE__ */ e.createElement(ae, {
				label: r,
				value: s.value,
				dynamic: s.dynamic,
				supported: Q === "macos",
				onChange: (e, a) => Y(async () => {
					let s = await E(t, "cli", ["session", "--help"]);
					if (!s.includes(`--${i}-threshold`) || !s.includes("--dynamic-listening")) throw Error(`Update berd-call to adjust ${r.toLowerCase()}.`);
					let c = {
						...o,
						[i]: {
							value: e,
							dynamic: a
						}
					};
					Q !== "macos" && (c.listening = {
						...c.listening,
						dynamic: !1
					}, c.interruption = {
						...c.interruption,
						dynamic: !1
					}), await E(t, "cli", [
						"detection-profile",
						"--settings",
						JSON.stringify(c)
					]);
					let l = [
						"--listening-threshold",
						String(c.listening.value),
						"--interruption-threshold",
						String(c.interruption.value),
						"--dynamic-listening",
						String(c.listening.dynamic),
						"--dynamic-interruption",
						String(c.interruption.dynamic)
					];
					V ? await n.restart(I(H?.sessionArguments ?? [], l)) : await oe(t, l);
				})
			}));
		}), Q === "macos" && H?.session?.detection?.settings?.timing && /* @__PURE__ */ e.createElement(e.Fragment, null, [[
			"Speech onset (ms)",
			"onset_ms",
			16,
			1e3,
			"Consecutive speech needed before detection. Longer values reject brief noises."
		], [
			"Speech release (ms)",
			"release_ms",
			300,
			3e3,
			"Silence needed to clear speech detection. Finalized transcripts are sent immediately."
		]].map(([r, i, a, o, s]) => {
			let c = H?.session?.detection?.settings, l = c?.timing ?? {
				onset_ms: 16,
				release_ms: 300
			};
			return /* @__PURE__ */ e.createElement(y, {
				key: i,
				title: r,
				subtitle: s
			}, /* @__PURE__ */ e.createElement(T, {
				label: r,
				value: l[i],
				min: 16,
				max: o,
				step: 16,
				empty: a,
				onChange: (e) => {
					e !== l[i] && Y(async () => {
						let r = JSON.parse(await E(t, "cli", ["detection-profile"]));
						if (!r.settings?.timing) throw Error("Update berd-call to adjust VAD timing.");
						let o = {
							...c ?? r.settings,
							timing: {
								...l,
								[i]: e ?? a
							}
						};
						await E(t, "cli", [
							"detection-profile",
							"--settings",
							JSON.stringify(o)
						]), V && await n.restart(I(H?.sessionArguments ?? [], [
							"--listening-threshold",
							String(o.listening.value),
							"--interruption-threshold",
							String(o.interruption.value),
							"--dynamic-listening",
							String(o.listening.dynamic),
							"--dynamic-interruption",
							String(o.interruption.dynamic)
						]));
					});
				}
			}));
		})), Q === "macos" && /* @__PURE__ */ e.createElement(y, {
			title: "Pending transcription hold (ms)",
			subtitle: "How long agent speech waits for unfinished transcription after detected speech ends. Recognition continues after this wait expires, and late words are still accepted. Default: 5000 ms. Changes restart the call."
		}, /* @__PURE__ */ e.createElement(T, {
			label: "Pending transcription hold (ms)",
			value: H?.session?.detection?.settings.pending_utterance_timeout_ms ?? 5e3,
			min: 250,
			max: 3e4,
			step: 250,
			empty: 5e3,
			onChange: (e) => Y(async () => {
				let r = JSON.parse(await E(t, "cli", ["detection-profile"]));
				if (typeof r.settings?.pending_utterance_timeout_ms != "number") throw Error("Update berd-call to adjust the pending transcription hold.");
				let i = {
					...r.settings,
					pending_utterance_timeout_ms: e ?? 5e3
				};
				await E(t, "cli", [
					"detection-profile",
					"--settings",
					JSON.stringify(i)
				]), V ? await n.restart(I(H?.sessionArguments ?? [], ["--pending-utterance-timeout-ms", String(i.pending_utterance_timeout_ms)])) : await oe(t, ["--pending-utterance-timeout-ms", String(i.pending_utterance_timeout_ms)]);
			})
		})), H?.audioSetup && /* @__PURE__ */ e.createElement(y, {
			title: "Audio setup",
			subtitle: `${H.audioSetup.input_name} microphone · ${H.audioSetup.output_name} output`
		}))), l && /* @__PURE__ */ e.createElement(re, { dictionary: l }), /* @__PURE__ */ e.createElement(M, { title: "Sounds" }, /* @__PURE__ */ e.createElement(y, {
			title: "Status sounds",
			subtitle: "Play a sound while agents work, and optionally when it is your turn."
		}, /* @__PURE__ */ e.createElement(b, {
			label: "Status sounds",
			value: H?.statusSounds ?? "working",
			options: we,
			onChange: (e) => Xe(["--status-sounds", e])
		}))), /* @__PURE__ */ e.createElement(M, { title: "Experimental" }, u && /* @__PURE__ */ e.createElement(y, {
			title: "Send words before they're final",
			subtitle: "When you pause, your agents privately get what you've said so far and can start on a reply. A reply to those words is spoken once they're final. Your final words still post as a message."
		}, /* @__PURE__ */ e.createElement(w, {
			label: "Send words before they're final",
			checked: R,
			onChange: (e) => u.set(e)
		})), c && /* @__PURE__ */ e.createElement(y, {
			title: "Replies you didn't hear",
			subtitle: "What an agent's reply becomes when newer speech kept it from being spoken, or you interrupted it."
		}, /* @__PURE__ */ e.createElement(b, {
			label: "Replies you didn't hear",
			value: le,
			options: [["strike", "Strike through"], ["edit", "Trim or delete"]],
			onChange: (e) => c.set(e)
		}))), /* @__PURE__ */ e.createElement(y, {
			title: "Reset to defaults",
			subtitle: "Restores Apple speech at normal speed and clears individual voice choices. Resets speech detection for this audio setup."
		}, /* @__PURE__ */ e.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-button",
			"data-variant": "secondary",
			"data-size": "sm",
			onClick: () => {
				Y(async () => {
					(await E(t, "cli", ["session", "--help"])).includes("--dynamic-listening") && await E(t, "cli", [
						"detection-profile",
						"--settings",
						JSON.stringify({
							listening: {
								value: .5,
								dynamic: !1
							},
							interruption: {
								value: .65,
								dynamic: !1
							}
						})
					]), await n.reset(), await Ye(["--status-sounds", "working"]), Object.keys(i.get()).forEach(i.remove), fe([]);
				});
			}
		}, "Reset"))), !H && /* @__PURE__ */ e.createElement("p", { role: "status" }, G ? "Could not load call settings. Reopen this page to try again." : "Loading call settings…"));
	}
	return {
		icon: e.forwardRef(({ size: t = "1em", ...n }, r) => /* @__PURE__ */ e.createElement("svg", {
			ref: r,
			width: t,
			height: t,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			...n
		}, /* @__PURE__ */ e.createElement("path", { d: "M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5-2.5l5 2v4a2 2 0 0 1-2 2a16 16 0 0 1-15-15a2 2 0 0 1 2-2" }))),
		id: "settings",
		title: "Berd Call",
		group: "Plugins",
		component: F
	};
}
//#endregion
//#region src/index.tsx
var Te = [
	"react",
	"conversation",
	"agents",
	"host",
	"settingsCards",
	"relay",
	"navigation"
], G = [
	"M5 8h6a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3H5a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3Z",
	"M8 8V4M5.5 13h.01M10.5 13h.01",
	"M20 4h-2l-1 4 2 1a12 12 0 0 1 0 6l-2 1 1 4h2a2 2 0 0 0 2 -2V6a2 2 0 0 0 -2 -2Z"
], K = ["M3 21l18 -18", "M5.831 14.161a15.946 15.946 0 0 1 -2.831 -8.161a2 2 0 0 1 2 -2h4l2 5l-2.5 1.5c.108 .22 .223 .435 .345 .645m1.751 2.277c.843 .84 1.822 1.544 2.904 2.078l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a15.963 15.963 0 0 1 -10.344 -4.657"], Ee = "@keyframes berd-call-pulse{50%{opacity:.4}}@media (prefers-reduced-motion:reduce){[data-berd-call=starting]{animation:none!important}}";
function De(e) {
	let { react: t, agents: r, host: i } = e;
	if (!i.spawn) return;
	let a = pe(localStorage), o = v(localStorage), c = n(localStorage), l = s(localStorage), d = fe(localStorage), f = u(localStorage);
	typeof r.addTool == "function" && H(r, d);
	let p = le(i, r, a, o, c, l, d, f);
	typeof r.addTool == "function" && R(e, p), e.effect(() => p.stop), p.busy, p.subscribe;
	let m = () => t.useSyncExternalStore(p.subscribe, p.snapshot), h = ({ session: e, channelId: n }) => (t.useEffect(() => e.channels.ensureList(), [e]), t.useSyncExternalStore(e.channels.subscribeList, () => e.channels.list().channels.find((e) => e.id === n)));
	function g(e) {
		let { session: n, channelId: i, threadRootId: a, disabled: o, recipients: s } = e, l = h(e), u = t.useSyncExternalStore(C(r, "").subscribe, () => S(r, i, l?.members)), d = s?.map(({ pubkey: e }) => e).join(" "), f = d || u, g = m(), _ = !!g.status && g.channelId === i, v = t.useRef({
			channelId: i,
			threadRootId: a,
			mentioned: d
		});
		t.useEffect(() => {
			let e = v.current;
			v.current = {
				channelId: i,
				threadRootId: a,
				mentioned: d
			}, _ && d && !a && e.channelId === i && e.threadRootId === a && e.mentioned !== d && p.aim(i, d.split(" "));
		}, [
			_,
			i,
			a,
			d
		]);
		let y = t.useSyncExternalStore(c.subscribe, c.get), b = p.targets().join(" "), x = e.replaceRecipientsIfEmpty ?? e.replaceRecipients;
		if (t.useEffect(() => {
			if (!_ || a || o || y === "picker" || b === d || !x) return;
			let e = p.targets().flatMap((e) => {
				let t = r.find(e)?.name;
				return t ? [{
					pubkey: e,
					name: t
				}] : [];
			});
			x(e);
		}, [
			_,
			a,
			o,
			y,
			b,
			x
		]), !["solo", "session"].includes(l?.channelType ?? "") || a) return null;
		let ee = !!g.status && !_, w = _ && g.status === "starting", T = w ? "Starting voice call…" : _ ? "End voice call" : ee ? "End the voice call in another chat and start one here" : "Start voice call";
		return /* @__PURE__ */ t.createElement("span", {
			role: "group",
			"aria-label": "Voice call controls",
			style: {
				position: "relative",
				display: "inline-flex"
			}
		}, /* @__PURE__ */ t.createElement("button", {
			type: "button",
			"data-buzz-ui": "",
			className: "buzz-button",
			"data-variant": "ghost",
			"data-size": "sm",
			"data-button-shape": "control",
			"data-icon-variant": "ghost",
			"data-icon-size": "sm",
			"data-icon-shape": "control",
			"aria-label": T,
			"aria-pressed": _,
			"aria-busy": w || void 0,
			"data-berd-call": _ ? g.status : void 0,
			title: T,
			style: w ? { animation: "berd-call-pulse 1.2s ease-in-out infinite" } : _ ? { color: "var(--text-danger)" } : void 0,
			disabled: o,
			onClick: () => _ ? p.stop() : f ? void p.start(n, i, f.split(" "), C(r, i)) : p.fail(i, "No agent to call in this chat. Message one here first.")
		}, w && /* @__PURE__ */ t.createElement("style", null, Ee), /* @__PURE__ */ t.createElement("span", { className: "buzz-button-label" }, /* @__PURE__ */ t.createElement("svg", {
			width: 18,
			height: 18,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true"
		}, (_ && !w ? K : G).map((e) => /* @__PURE__ */ t.createElement("path", {
			key: e,
			d: e
		}))))), _ && !g.error && g.status === "live" && g.inputSpeaking && /* @__PURE__ */ t.createElement("span", {
			role: "status",
			"aria-label": "Speech detected",
			style: {
				position: "absolute",
				bottom: 0,
				left: "50%",
				transform: "translateX(-50%)",
				display: "flex",
				pointerEvents: "none",
				color: "var(--text-danger)"
			}
		}, /* @__PURE__ */ t.createElement("style", null, "@keyframes berd-call-typing{0%,100%{opacity:.35}50%{opacity:1}}@media(prefers-reduced-motion:no-preference){[data-berd-call-typing]>span{animation:berd-call-typing 1.4s ease-in-out infinite backwards}}"), /* @__PURE__ */ t.createElement("span", {
			"data-berd-call-typing": "",
			"aria-hidden": "true",
			style: {
				display: "flex",
				gap: "var(--space-half, 2px)"
			}
		}, [
			0,
			1,
			2
		].map((e) => /* @__PURE__ */ t.createElement("span", {
			key: e,
			style: {
				width: "3px",
				height: "3px",
				borderRadius: "50%",
				background: "currentColor",
				animationDelay: `${e * .2}s`
			}
		})))));
	}
	function _({ channelId: e, threadRootId: n }) {
		let r = m();
		return n || r.channelId !== e || !r.error ? null : /* @__PURE__ */ t.createElement("p", {
			role: "status",
			style: {
				margin: 0,
				padding: "2px var(--space-2, 8px)",
				fontSize: "var(--font-size-sm, 12px)",
				color: "var(--text-danger)"
			}
		}, r.status ? "Voice call" : "Voice call failed", ": ", r.error);
	}
	e.conversation.registerTool({
		id: "call",
		title: "Berd Call",
		order: 11,
		component: g
	}), e.conversation.registerAccessory({
		id: "status",
		title: "Berd Call",
		component: _
	}), e.settingsCards.register(W(t, i, p, r, a, o, e.relay, c, l, d, f));
}
//#endregion
export { De as apply, Te as inject };
