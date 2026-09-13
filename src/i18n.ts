// v0.30: bilingual narrative layer (en/zh) for the advice/warnings/tradeoffs
// text that the analysis tools attach to their numeric results.
//
// Design rules:
//  - Templates use {placeholder} interpolation; numbers, exchange names and
//    asset symbols are always passed as params so no locale formatting leaks
//    into the catalog.
//  - Machine-oriented strings (error codes/messages, field names, data-file
//    notes) stay English — only human narrative translates.
//  - Lang is threaded explicitly through function parameters (never module
//    state) so concurrent HTTP requests stay isolated.

export type Lang = "en" | "zh";

/** Validate an untrusted language value; anything unknown falls back to "en". */
export function pickLang(v: unknown): Lang {
  return v === "zh" ? "zh" : "en";
}

type Template = { en: string; zh: string };

export const MSG = {
  // ---------- data freshness ----------
  fresh_unparseable: {
    en: "Fee data has an unparseable last_verified value '{asOf}'; treat rates as outdated.",
    zh: "费率数据的 last_verified 值“{asOf}”无法解析；请将费率视为过期数据。",
  },
  fresh_stale: {
    en: "Fee data was last verified {asOf} ({months} months ago); exchange schedules may have changed. Verify with get_data_sources before deciding.",
    zh: "费率数据最后核验于 {asOf}（{months} 个月前）；交易所费率可能已调整。决策前请用 get_data_sources 复核。",
  },

  // ---------- small shared suffixes / nouns ----------
  s_wd_net: { en: " on {net}", zh: "（{net} 网络）" },
  s_wd_for_net: { en: " for {asset}-{net}", zh: "（{asset}-{net}）" },
  s_wd_for_asset: { en: " for {asset}", zh: "（{asset}）" },
  s_ft_via: { en: " via {method}", zh: "（{method} 渠道）" },
  s_ft_dir_deposit: { en: "deposit", zh: "入金" },
  s_ft_dir_withdraw: { en: "withdrawal", zh: "出金" },
  s_ft_leg_deposit: { en: "funding your account", zh: "入金" },
  s_ft_leg_withdraw: { en: "cashing out to your bank", zh: "出金到银行" },
  s_leg_deposit: { en: "deposit", zh: "入金" },
  s_leg_cashout: { en: "cash-out", zh: "出金" },
  s_purpose_spot: { en: "spot", zh: "现货" },
  s_purpose_futures: { en: "futures", zh: "合约" },
  s_aop: { en: "assets on platform (AOP)", zh: "平台资产(AOP)" },
  s_assets: { en: "account assets", zh: "账户资产" },
  s_and_gt: { en: " and current GT holdings", zh: "和当前 GT 持仓" },
  s_and_kcs: { en: " and current KCS holdings", zh: "和当前 KCS 持仓" },
  s_and_assets: { en: " and current asset holdings", zh: "和当前资产持仓" },

  // ---------- VIP tier qualification warnings (buildTierWarning) ----------
  tw_bnb_back: {
    en: "Volume qualifies for tier {volumeTier}, which requires holding at least {min} BNB; with {balance} BNB the effective fee tier is {tier}.",
    zh: "交易量达到 {volumeTier} 档，该档要求至少持有 {min} BNB；当前持有 {balance} BNB，实际生效档位为 {tier}。",
  },
  tw_bnb_missing: {
    en: "Quoted tier {tier} requires holding at least {min} BNB in addition to volume. Pass tokenBalance to price your actual tier; without enough BNB you fall to a lower tier.",
    zh: "报价档位 {tier} 除交易量外还要求至少持有 {min} BNB。请传入 tokenBalance 以按实际档位计价；BNB 不足会降档。",
  },
  tw_gt_up: {
    en: "Volume alone qualifies for {volumeTier}; holding GT lifts the effective fee tier to {tier} because Gate qualifies VIP levels via 30-day volume OR average GT holdings, whichever is higher.",
    zh: "仅交易量即可达 {volumeTier} 档；持有 GT 将生效档位提升至 {tier}——Gate 按 30 日交易量 OR 平均 GT 持仓两者取高定 VIP。",
  },
  tw_gt_next: {
    en: "Tier {tier} is set by your 30-day volume{andHolding}. Holding at least {min} GT would lift you to {nextTier} — Gate qualifies via volume OR GT holdings, whichever is higher. Pass tokenBalance to price the upgraded tier.",
    zh: "档位 {tier} 由你的 30 日交易量{andHolding}决定。至少持有 {min} GT 可升至 {nextTier}——Gate 按交易量 OR GT 持仓取高定档。请传入 tokenBalance 以按升档计价。",
  },
  tw_kcs_up: {
    en: "Volume alone qualifies for {volumeTier}; holding KCS lifts the effective fee tier to {tier} because KuCoin qualifies VIP levels via 30-day volume OR KCS holdings, whichever is higher.",
    zh: "仅交易量即可达 {volumeTier} 档；持有 KCS 将生效档位提升至 {tier}——KuCoin 按 30 日交易量 OR KCS 持仓两者取高定 VIP。",
  },
  tw_kcs_next: {
    en: "Tier {tier} is set by your 30-day volume{andHolding}. Holding at least {min} KCS would lift you to {nextTier} — KuCoin qualifies via volume OR KCS holdings, whichever is higher. Pass tokenBalance to price the upgraded tier.",
    zh: "档位 {tier} 由你的 30 日交易量{andHolding}决定。至少持有 {min} KCS 可升至 {nextTier}——KuCoin 按交易量 OR KCS 持仓取高定档。请传入 tokenBalance 以按升档计价。",
  },
  tw_asset_up: {
    en: "Volume alone qualifies for {volumeTier}; {assetNoun} lift the effective fee tier to {tier} because {name} qualifies {tierNoun} via 30-day volume OR {assetNoun}, whichever is higher.",
    zh: "仅交易量即可达 {volumeTier} 档；{assetNoun}将生效档位提升至 {tier}——{name} 按 30 日交易量 OR {assetNoun}两者取高定{tierNoun}。",
  },
  tw_asset_next: {
    en: "Tier {tier} is set by your 30-day volume{andHolding}. Holding at least {minAssets} in {name} {assetNoun} would lift you to {nextTier} — {name} qualifies {tierNoun} via volume OR {assetNoun}, whichever is higher. Pass accountAssetsUsd to price the upgraded tier.",
    zh: "档位 {tier} 由你的 30 日交易量{andHolding}决定。在 {name} 持有至少 {minAssets} {assetNoun}可升至 {nextTier}——{name} 按交易量 OR {assetNoun}取高定{tierNoun}。请传入 accountAssetsUsd 以按升档计价。",
  },

  // ---------- withdrawal comparison ----------
  wd_unsupported: {
    en: "{n} exchanges do not list {asset}{onNet} withdrawals.",
    zh: "{n} 家交易所不支持{asset}{onNet}提币。",
  },
  wd_suspended_only: {
    en: "{n} exchanges only show suspended routes{forNet} (wallets paused 2026-09; check resumption).",
    zh: "{n} 家交易所的{forNet}提币路线全部处于暂停状态（钱包 2026-09 暂停，请关注恢复时间）。",
  },
  wd_suspended_routes: {
    en: "{n} suspended routes shown with available=false alongside open alternatives.",
    zh: "有 {n} 条暂停路线以 available=false 标注，与可用路线并列展示。",
  },
  wd_adv_none: {
    en: "No open {asset}{net} withdrawal route matched across supported venues. Choose another network or retry after wallet maintenance; on-chain fees fluctuate so confirm on the withdrawal confirmation page.",
    zh: "所有支持的交易所在{asset}{net}上均无开放提币路线。请换一条网络或等钱包维护结束后重试；链上费用实时波动，最终以提币确认页为准。",
  },
  wd_adv_best: {
    en: "Cheapest {asset}{net} withdrawal: {ex} charges {fee} {asset} (about {usd}).{saving} L2/stablecoin routes are often a fraction of mainnet fees — verify the receiving wallet supports the same network.{priceNote}",
    zh: "最便宜的{asset}{net}提币：{ex} 收取 {fee} {asset}（约 {usd}）。{saving}L2/稳定币路线通常只有主网费用的零头——请确认接收钱包支持同一网络。{priceNote}",
  },
  wd_adv_saving: {
    en: " That saves about {usd} versus the most expensive open venue.",
    zh: "相比最贵的可用交易所约节省 {usd}。",
  },
  wd_adv_price: {
    en: " Native-unit fee converted at the snapshot price {price} per {asset}.",
    zh: "原生币种费用按快照价 {price}/{asset} 折算。",
  },

  // ---------- fiat rails ----------
  ft_unavailable: {
    en: "{n} exchanges had no qualifying {direction} rail for {currency}{via} (route availability depends on residency and KYC).",
    zh: "{n} 家交易所在 {currency} 上没有符合条件的{direction}通道{via}（路线可用性取决于居住地和 KYC）。",
  },
  ft_no_country: {
    en: "No country provided: region-locked rails (SEPA/FPS/PIX/ACH) were included regardless of residency; pass country for an availability-accurate list.",
    zh: "未提供国家代码：地区限定通道（SEPA/FPS/PIX/ACH）未按居住地过滤全部纳入；请传 country 以获得准确的可用性清单。",
  },
  ft_region_mismatch: {
    en: "Country {country} primarily uses {regionCur} but {currency} rails were requested; availability may be limited.",
    zh: "{country} 主要使用 {regionCur}，但你查询的是 {currency} 通道；可用性可能受限。",
  },
  ft_adv_none: {
    en: "No direct {direction} rail matched. Users in this situation typically fund via third-party card gateways (1.99%-5.5% at checkout) or zero-fee P2P with an embedded quote spread; model both before committing.",
    zh: "没有匹配到直连{direction}通道。此情形下用户通常走第三方刷卡网关（结账时 1.99%-5.5%）或零手续费但内嵌点差的 P2P；请先对两者分别估算再决定。",
  },
  ft_adv_free: {
    en: "{ex} offers a free {method} {direction} for {currency} — {amount} {currency} ({usd}) arrives in full.{saving} Cards cost 1.1%-4.5% everywhere, so use the bank rail whenever speed is not critical.",
    zh: "{ex} 对 {currency} 提供{method}{direction}免费通道——{amount} {currency}（{usd}）全额到账。{saving}刷卡各处都要 1.1%-4.5%，不赶时间就优先走银行通道。",
  },
  ft_adv_saving: {
    en: " Picking it over the most expensive supported venue saves about {usd} on this transfer.",
    zh: "相比最贵的可用交易所，此笔转账约节省 {usd}。",
  },
  ft_adv_paid: {
    en: "Cheapest {leg}: {ex} via {method} charges {fee} {currency} ({usd}, about {pct}%) on {amount} {currency}; {net} {currency} arrives net.{saving} Compare against zero-fee P2P (embedded spread) and third-party gateway quotes at checkout.",
    zh: "最便宜的{leg}方案：{ex} 经 {method} 收取 {fee} {currency}（{usd}，约 {pct}%），{amount} {currency} 实际到账 {net} {currency}。{saving}建议与零手续费 P2P（内嵌点差）及第三方刷卡网关报价对比。",
  },

  // ---------- recommend_exchange advice ----------
  re_pair_pricing: {
    en: "Pair-level pricing applies to {ex}: {note}",
    zh: "{ex} 适用币对级费率：{note}",
  },
  re_referral: {
    en: "Register via the {ex} link to lock {disc} off trading fees.",
    zh: "通过 {ex} 的返佣链接注册，可锁定 {disc} 的交易手续费减免。",
  },
  re_token_gate: {
    en: "Holding {token} unlocks up to {pct}% off — set useToken=true and tokenBalance to price your exact discount.",
    zh: "持有 {token} 最高可享 {pct}% 折扣——设 useToken=true 并传 tokenBalance 可精确计算你的折扣。",
  },
  re_token_other: {
    en: "Holding {token} unlocks another {pct}% off — set useToken=true to price it in.",
    zh: "持有 {token} 可再享 {pct}% 折扣——设 useToken=true 即可计入。",
  },
  re_no_fiat_rail: {
    en: "The winner lacks a direct {cur} {legs} rail — its real on/off-ramping runs through third-party gateways or P2P (typically 1.99-5.5%); check an alternative with a free bank rail before committing.",
    zh: "冠军所缺少直连 {cur} {legs}通道——实际出入金需经第三方网关或 P2P（通常 1.99-5.5%）；落地前建议对比一家有免费银行通道的替代所。",
  },
  re_fiat_cheaper: {
    en: "{ex} charges ~{usd}/yr less for your exact fiat habit — on/off-ramp there and transfer in if fiat fees dominate.",
    zh: "按你的法币习惯，{ex} 每年约省 {usd} 的出入金费用——若法币成本占大头，可在该所出入金后再划转。",
  },
  re_fx_note: {
    en: "Amounts shown in {cur} at a static display rate.",
    zh: "金额以 {cur} 按静态展示汇率折算。",
  },

  // ---------- recommend_exchange per-row reasons ----------
  re_label_fees: { en: "trading fees", zh: "交易手续费" },
  re_label_funding: { en: "funding cost", zh: "资金费成本" },
  re_label_spread: { en: "spread and slippage", zh: "点差与滑点" },
  re_label_fiat: { en: "fiat on/off-ramping", zh: "法币出入金" },
  re_reason_best: { en: "Best combined score of {parts}", zh: "在{parts}上综合得分最优" },
  re_reason_best_single: {
    en: "Lowest weighted fee rate among available exchanges",
    zh: "可用交易所中加权费率最低",
  },
  re_reason_weighted: {
    en: "Weighted fee {rate} (maker {maker} / taker {taker}, tier {tier})",
    zh: "加权费率 {rate}（maker {maker} / taker {taker}，档位 {tier}）",
  },
  re_reason_token: { en: "{token} discount applied", zh: "已应用 {token} 折扣" },
  re_reason_ref: { en: "Referral discount {disc} via registration link", zh: "注册链接返佣 {disc}" },
  re_reason_funding: { en: "Avg funding {rate} per {interval}h", zh: "平均资金费 {rate}/（{interval} 小时）" },
  re_reason_spread_live: {
    en: "Live execution cost ~{usd} on a {size} market order (spread + slippage)",
    zh: "实时执行成本约 {usd}（{size} 市价单，点差+滑点）",
  },
  re_reason_spread_est: {
    en: "Estimated spread crossing ~{usd} on a {size} market order (use spreadMode=live for size-based slippage)",
    zh: "估算点差成本约 {usd}（{size} 市价单；用 spreadMode=live 可按规模计滑点）",
  },
  re_reason_fiat_head: { en: "Direct fiat: {legs}", zh: "法币通道：{legs}" },
  re_reason_fiat_dep: {
    en: "{n} {cur} {method} deposits ~{usd}/yr",
    zh: "每年 {n} 次 {cur} {method} 入金，约 {usd}/年",
  },
  re_reason_fiat_cash: {
    en: "{n} {method} cash-out{x} ~{usd}/yr",
    zh: "每年 {n} 次 {method} 出金，约 {usd}/年",
  },
  re_reason_no_dep: { en: "no direct deposit rail", zh: "无直连入金通道" },
  re_reason_no_cash: { en: "no direct cash-out rail", zh: "无直连出金通道" },

  // ---------- recommend_exchange tradeoffs ----------
  to_min_bnb: { en: "Requires holding {n} BNB for tier rate", zh: "该档费率要求持有 {n} BNB" },
  to_min_gt: { en: "Requires holding {n} GT for tier rate", zh: "该档费率要求持有 {n} GT" },
  to_fee_above: { en: "Fee estimate ~{usd} above the cheapest option", zh: "手续费估算比最便宜方案高约 {usd}" },
  to_funding_above: { en: "Funding cost ~{usd} above {ex}", zh: "资金费成本比 {ex} 高约 {usd}" },
  to_exec_above: { en: "Spread/slippage ~{usd} above {ex} for this size", zh: "该单笔规模下点差/滑点比 {ex} 高约 {usd}" },
  to_no_deposit: {
    en: "No direct {cur} deposit rail — real on-ramping runs through third-party gateways/P2P (typically 1.99-5.5% at checkout)",
    zh: "无直连 {cur} 入金通道——实际入金需经第三方网关/P2P（结账时通常 1.99-5.5%）",
  },
  to_no_cashout: {
    en: "No direct {cur} cash-out rail — off-ramping actually costs more than modeled here",
    zh: "无直连 {cur} 出金通道——实际出金成本高于本估算",
  },
  to_fiat_above: { en: "Direct fiat on/off-ramping ~{usd}/yr above {ex}", zh: "直连法币出入金年成本比 {ex} 高约 {usd}" },

  // ---------- annual cost upgrade hint ----------
  ac_path_volume: { en: "{usd} 30-day volume", zh: "{usd} 30日交易量" },
  ac_path_assets: { en: "{usd} {assetLabel}", zh: "{usd} {assetLabel}" },
  ac_path_gt: { en: "{n} GT holdings", zh: "{n} GT 持仓" },
  ac_path_kcs: { en: "{n} KCS holdings", zh: "{n} KCS 持仓" },
  ac_up_bnb: {
    en: "Reach {tier} with {usd} 30-day volume AND {bnb} BNB holdings",
    zh: "以 {usd} 30日交易量 且 {bnb} BNB 持仓达到 {tier}",
  },
  ac_up_or: { en: "Reach {tier} via {paths}", zh: "以 {paths} 任一条件达到 {tier}" },
  ac_hint: {
    en: "{req}; estimated annual trading-fee saving {save}{cur} at your current monthly volume.",
    zh: "{req}；按当前月交易量估算，年交易手续费可省 {save}{cur}。",
  },

  // ---------- persona analysis ----------
  pe_warn_no_deposit: {
    en: "{names} have no direct {cur} deposit rail in {cc} — their fiat cost is EXCLUDED from annual_all_in, not zero. On-ramping actually runs through P2P or third-party gateways (Banxa/Simplex/MoonPay-style), typically 1.99-5.5% at checkout.",
    zh: "{names} 在 {cc} 没有直连 {cur} 入金通道——其法币成本在 annual_all_in 中是“未计入”而非零。实际入金走 P2P 或第三方网关（Banxa/Simplex/MoonPay 类），结账时通常 1.99-5.5%。",
  },
  pe_warn_no_cashout: {
    en: "{names} have no direct {cur} cash-out rail in {cc}; cash-out cost excluded for those venues.",
    zh: "{names} 在 {cc} 没有直连 {cur} 出金通道；这些所的出金成本未计入。",
  },
  pe_warn_no_wd: {
    en: "{names} do not list an open {asset} withdrawal route — withdrawal cost is EXCLUDED for those rows (you would need to bridge/swap asset first, at extra cost).",
    zh: "{names} 无开放的 {asset} 提币路线——这些行的提币成本“未计入”（需先跨链/兑换资产，产生额外成本）。",
  },
  pe_warn_spot_only: {
    en: "{names} excluded: spot-only venue(s), no futures fee ladder.",
    zh: "{names} 已排除：仅提供现货，无合约费率阶梯。",
  },
  pe_reason_lowest: {
    en: "Lowest modeled annual all-in cost for this persona: {amt} at the {tier} tier",
    zh: "该画像下模拟年化全包成本最低：{tier} 档 {amt}",
  },
  pe_reason_dominant: {
    en: "Also cheapest on your dominant cost: {label} ({amt}/yr)",
    zh: "在你的主导成本项上也最便宜：{label}（{amt}/年）",
  },
  pe_reason_ref: {
    en: "Carries a configured fee-discount referral link (already reflected in the rate)",
    zh: "配有已配置的手续费减免返佣链接（费率中已体现）",
  },
  pe_to_leg: {
    en: "{label} is cheapest at {ex} ({amt}/yr) — about {amt2}/yr less than the winner",
    zh: "{label}在 {ex} 最便宜（{amt}/年）——比冠军所约低 {amt2}/年",
  },
  pe_to_no_fiat: {
    en: "Winner has NO direct fiat rail in {cc} — the ranking excludes unmodeled gateway/P2P fees (typically 1.99-5.5%); if you on-ramp via card every month, a venue with free bank rails can still win in practice",
    zh: "冠军所在 {cc} 没有直连法币通道——排名未计入网关/P2P 费用（通常 1.99-5.5%）；若你每月刷卡入金，有免费银行通道的所实际用起来可能更划算",
  },
  pe_to_no_wd: {
    en: "Winner lists no open {asset} withdrawal route; bridging/swapping adds unmodeled cost",
    zh: "冠军所无开放的 {asset} 提币路线；跨链/兑换会产生未计入的成本",
  },
  pe_adv_head: {
    en: "Persona \"{nameA}\" ({nameB}): {tagline} Ranking assumes {assumptions}.",
    zh: "画像“{nameA}”（{nameB}）：{tagline} 排名假设：{assumptions}。",
  },
  pe_adv_best: {
    en: "Best fit in {cc}: {ex} — modeled {amt}/yr all-in, about {amt2}/yr less than runner-up {ex2}.",
    zh: "{cc} 最佳选择：{ex}——模拟年化全包 {amt}，比亚军 {ex2} 约省 {amt2}/年。",
  },
  pe_adv_to: { en: "Trade-off: {t}.", zh: "权衡：{t}。" },
  pe_adv_complete: {
    en: "The winner above has unpriced legs (missing fiat rail and/or withdrawal route). Among venues where EVERY cost in this persona is priced, the realistic pick is {ex} at {amt}/yr — {amt2}/yr more than the headline winner, with no gateway/P2P/bridging surprise.",
    zh: "上述冠军存在未定价成本项（缺法币通道和/或提币路线）。在所有成本项均可定价的交易所中，现实之选是 {ex}（{amt}/年）——比名义冠军多 {amt2}/年，但不会有网关/P2P/跨链的意外开销。",
  },
  pe_adv_upgrade: {
    en: "Next-tier upgrade at {ex}: {hint}",
    zh: "{ex} 升档建议：{hint}",
  },
  pe_tok_flat: {
    en: "{ex}: enable {token} fee deduction for ~{pct}% off (any balance) — saves ~{amt}/yr, no capital lock-up required",
    zh: "{ex}：开启 {token} 抵扣约省 {pct}%（任意余额即可）——每年约省 {amt}，无需锁仓",
  },
  pe_tok_tier: {
    en: "{ex}: hold ~{amt} of {token} for {pct}% off — saves ~{amt2}/yr, {payback}",
    zh: "{ex}：持有约 {amt} 的 {token} 享 {pct}% 折扣——每年约省 {amt2}，{payback}",
  },
  pe_tok_payback: { en: "{n}mo payback", zh: "回本约 {n} 个月" },
  pe_tok_marginal: { en: "saving is marginal", zh: "节省幅度甚微" },
  pe_tok_intro: {
    en: "Native-token discount opportunities (this ranking assumed NO token discount): {lines}.",
    zh: "平台币折扣机会（本排名未计入任何平台币折扣）：{lines}。",
  },
  pe_tok_risk: {
    en: "Holding a native token carries exchange-failure risk (the token can go to zero, as with FTT/FTX). Rerun with useToken=true (and tokenBalance where relevant) to fold the discount into the all-in ranking.",
    zh: "持有平台币有交易所倒闭风险（代币可能归零，如 FTT/FTX）。可用 useToken=true（必要时加 tokenBalance）重算，把折扣并入全包排名。",
  },
  pe_tok_none: {
    en: "Preset assumes NO native-token discount. None of the top-ranked venues offer a separate native-token toggle on this product; compare tiers via calculate_annual_cost instead.",
    zh: "预设未计入平台币折扣。排名靠前的交易所在该产品上均无独立的平台币抵扣开关；请用 calculate_annual_cost 比较档位。",
  },
  pe_funding: {
    en: "Funding is priced at the bundled neutral long-run average (0.01%/8h equivalent). Funding floats with the market and can turn negative; rerun with fundingMode=live to price the current rate.",
    zh: "资金费按内置的中性长期均值计价（等效 0.01%/8h）。资金费随市场浮动且可能转负；可用 fundingMode=live 重算以按当前费率计价。",
  },
  pe_depth: {
    en: "At a {amt} clip size, real order-book depth matters: bundled mode prices half-spread only with zero slippage — rerun with spreadMode=live for a top-100 depth walk.",
    zh: "单笔 {amt} 的规模下，真实盘口深度开始重要：内置模式只计半个点差、零滑点——可用 spreadMode=live 重算，走前 100 档深度吃单模拟。",
  },
  pe_presets: {
    en: "Presets are research-anchored archetypes, not your exact profile — override monthlyVolumeUsd, makerShare, accountAssetsUsd, holdingHours or tradeSizeUsd to fit your real behavior.",
    zh: "画像是研究锚定的典型原型，并非你的真实 profile——可用 monthlyVolumeUsd、makerShare、accountAssetsUsd、holdingHours、tradeSizeUsd 覆盖参数以贴合实际行为。",
  },

  // ---------- token discount ----------
  td_no_discount: {
    en: "{ex} has no separate native-token fee discount on {purpose} ({token}).",
    zh: "{ex} 在{purpose}上没有独立的平台币手续费折扣（{token}）。",
  },
  td_okx: {
    en: "OKX bakes OKB value into its VIP tier table — there is no extra fee-deduction toggle. Compare tiers via calculate_annual_cost instead.",
    zh: "OKX 已把 OKB 价值折进 VIP 档位表——没有额外的手续费抵扣开关。请改用 calculate_annual_cost 比较档位。",
  },
  td_no_price: {
    en: "No bundled USD price for {token}; pass tokenPriceUsd for a payback estimate.",
    zh: "内置数据没有 {token} 的美元价；请传 tokenPriceUsd 以估算回本周期。",
  },
  td_zero: {
    en: "At this balance the token discount saves nothing vs. the no-token tier (e.g. maker is already a rebate or the venue has no toggle). Holding the token is optional.",
    zh: "在该持仓量下，平台币折扣相对无币档位没有节省（例如 maker 已是返佣，或该所无抵扣开关）。可选择性持有。",
  },
  td_payback: {
    en: "At {months} months payback, the discount recoups ~{amt} of locked {token} in under a year only if the token price holds — it can drop up to {pct}% over 12 months before the saving is wiped out.",
    zh: "回本周期 {months} 个月：仅当代币价格站稳时，折扣才能在一年内收回约 {amt} 的 {token} 锁仓——12 个月内币价最多可跌 {pct}%，再多节省即被抹平。",
  },
  td_best_tier: {
    en: "Best payback tier: {pct}% off at {bal} — ~{amt}/yr saving, {months} months to recoup {amt2} of locked capital.",
    zh: "最优回本档位：{bal} 享 {pct}% 折扣——每年约省 {amt}，{months} 个月收回 {amt2} 锁仓资金。",
  },
  td_bal_tier: { en: "{min} {token}", zh: "{min} {token} 持仓" },
  td_bal_flat: { en: "any {token} balance (flat discount)", zh: "任意 {token} 余额（固定折扣）" },
  td_risk: {
    en: "Holding a native token carries exchange-failure risk (the token can go to zero, as with FTT/FTX). Treat payback as a floor, not a guarantee; verify current token price and tier terms before committing.",
    zh: "持有平台币有交易所倒闭风险（代币可能归零，如 FTT/FTX）。回本周期只是下限而非保证；操作前请核实代币现价与档位条款。",
  },
  td_terms: { en: "{token} terms: {desc}", zh: "{token} 条款：{desc}" },
  wi_cheapest: {
    en: "At {volume}/month, {exchange} ({tier}) is cheapest — about {usd}/year in pure trading fees.",
    zh: "月成交量 {volume} 时，{exchange}（{tier} 档）交易费最低——纯交易手续费一年约 {usd}。",
  },
  wi_upgrade: {
    en: "{exchange}: trade ~{add}/month more to reach {tier}; at your current volume that tier would save about {usd}/year.",
    zh: "{exchange}：月成交量再增加约 {add} 可升至 {tier} 档；按你当前成交量，该档一年约省 {usd}。",
  },
  wi_upgrade_gate: {
    en: "{exchange}: the next volume rung {tier} (at {volume}/month) does NOT lower your fee by volume alone — it also requires the platform-token/asset holding condition.",
    zh: "{exchange}：下一档 {tier}（需月成交量 {volume}）单靠刷量无法降费——还需满足平台币/资产持仓条件。",
  },
  wi_no_upgrade: {
    en: "At your current volume no venue's next tier offers an immediate fee reduction; revisit the curve as your volume grows.",
    zh: "以你当前的成交量，没有任何交易所的下一档能立刻降低费率；成交量增长后再回看此曲线。",
  },
  wi_points_capped: {
    en: "More than {max} sweep points are possible; points were sampled across the full range — pass explicit volumes for full resolution.",
    zh: "可扫描的档位点超过 {max} 个，已在全区间内抽样；需要完整分辨率请显式传入 volumes。",
  },
  cc_row: {
    en: "{country}: {exchange} ({tier}) is cheapest at about {usd}/year; {n} venues are available.",
    zh: "{country}：{exchange}（{tier} 档）最便宜，一年约 {usd}；可用交易所 {n} 家。",
  },
  cc_gap: {
    en: "The exact same trader pays {delta}/year more in {hi} than in {lo} ({pct}% more).",
    zh: "完全相同的交易者，在 {hi} 比在 {lo} 一年多花 {delta}（高 {pct}%）。",
  },
  cc_venue: {
    en: "{venue} is unavailable in {countries}.",
    zh: "{venue} 在 {countries} 不可用。",
  },
  cc_wins: {
    en: "{exchange} is the cheapest in {n} of {total} countries: {countries}.",
    zh: "{exchange} 在 {total} 个国家中的 {n} 个最便宜：{countries}。",
  },
  cc_row_error: {
    en: "{country}: no venue could price this profile ({code}).",
    zh: "{country}：没有交易所可对该画像完整定价（{code}）。",
  },
  cc_complete: {
    en: "{country}: headline winner {winner} misses some cost rails; the realistic all-legs pick is {complete} ({extra}/yr more).",
    zh: "{country}：名义最便宜的 {winner} 缺少部分成本通道；各成本腿齐全的现实选择是 {complete}（一年多 {extra}）。",
  },

  // ---------- v0.46: MiCA stablecoin availability (USDT in the EEA) ----------
  sc_warn_trade: {
    en: "MiCA stablecoin access: {asset} has no EU e-money-token authorization, and since the MiCA transition ended on {effective} licensed EEA venues cannot offer {asset} spot pairs (pairs were removed in waves from Dec 2024 to Mar 2025). The fees below are the venues' published schedule figures — an EEA resident cannot actually trade this pair on these venues. Holding, sending and withdrawing {asset} to self-custody remain legal; compliant alternatives on EEA books: {alts}. Use get_stablecoin_access for the venue-by-venue matrix.",
    zh: "MiCA 稳定币可用性提示：{asset} 未获得欧盟电子货币代币授权，自 {effective} MiCA 过渡期结束后，持牌 EEA 场馆不得向 EEA 用户提供 {asset} 现货交易对（各场馆已在 2024-12 至 2025-03 间分批下架）。以下费率只是场馆公布的费率表数字——EEA 居民实际上无法在这些场馆交易该币对。个人持有、转账和提币到自托管钱包仍然合法；EEA 场内合规替代品：{alts}。逐场馆明细可用 get_stablecoin_access 查询。",
  },
  sc_warn_withdrawal: {
    en: "MiCA stablecoin access: {asset} trading pairs are gone from licensed EEA venues (transition ended {effective}), but ESMA confirms individuals keep the right to hold and withdraw {asset} on-chain. The network fees below apply to withdrawing residual balances; new EEA on-ramps and spot trading for {asset} are not available — plan to convert to {alts} or move to self-custody. Use get_stablecoin_access for venue-by-venue custody/withdrawal notes.",
    zh: "MiCA 稳定币可用性提示：{asset} 现货交易对已从持牌 EEA 场馆消失（过渡期 {effective} 结束），但 ESMA 明确个人仍有权持有并在链上提走 {asset}。以下网络费适用于提取存量余额；EEA 场内已无法新买 {asset} 或现货交易——请规划转换为 {alts} 或转至自托管。各场馆托管/提币说明可用 get_stablecoin_access 查询。",
  },
  sc_warn_persona: {
    en: "MiCA stablecoin access: this scenario holds/withdraws in {asset}, which has no EU e-money-token authorization. Licensed EEA venues cannot offer {asset} trading after {effective}; the venue rows below only model on-chain withdrawal of any residual balance (self-custody withdrawal remains legal), not {asset} trading income. Compliant alternatives: {alts}.",
    zh: "MiCA 稳定币可用性提示：该画像是以 {asset} 持仓/提币的，而 {asset} 未获欧盟电子货币代币授权。{effective} 之后持牌 EEA 场馆不得提供 {asset} 交易；下面各场馆行只对存量余额的链上提币建模（提币到自托管仍合法），并不代表可在 {asset} 上产生交易收益。合规替代品：{alts}。",
  },
  sc_advice_eea: {
    en: "As an EEA resident you cannot buy or trade {asset} on any MiCA-licensed venue after {effective}; choose {alts} for on-venue trading, or hold/send {asset} through self-custody. Check each delisted venue's custody and on-chain withdrawal policy before transferring.",
    zh: "作为 EEA 居民，{effective} 之后你无法在任何 MiCA 持牌场馆买入或交易 {asset}；场内交易请选 {alts}，{asset} 本身可通过自托管持有和转账。转账前请逐家确认下架场馆的托管与链上提币政策。",
  },
  sc_advice_global: {
    en: "MiCA does not apply in your country: {asset} remains tradable on venues that serve you. The EEA restrictions shown only bind EU/EEA residents; self-custody is legal on both sides. If you later travel or move into the EEA, on-venue {asset} access would be lost.",
    zh: "MiCA 不适用于你所在的国家/地区：{asset} 在向你提供服务的场馆上仍可正常交易。表中的 EEA 限制只约束欧盟/EEA 居民；两地的自托管均合法。若你日后进入 EEA，将失去场内 {asset} 的交易入口。",
  },
  sc_advice_authorized: {
    en: "{asset} is MiCA-authorized and remains fully available on licensed EEA venues; no regional access restriction applies.",
    zh: "{asset} 已获 MiCA 授权，在持牌 EEA 场馆全面可用；不存在区域可用性限制。",
  },

  // ---------- v0.47: consumer-vs-pro interface costs ----------
  iface_warn_trade: {
    en: "Consumer-interface cost gap: the {exchange} row above prices the {pro_product} order book ({pro_taker}% taker), but the venue's consumer app costs far more — measured {rt}% on a €100 market round-trip (TUM real-money study 2025-10..11; ≈{one_way}% per side incl. spread). Use {pro_product} or the venue's API for the published pricing, or compare_interface_costs for the full breakdown.",
    zh: "界面成本差距：上方 {exchange} 行按 {pro_product} 订单簿费率计价（taker {pro_taker}%），但该馆 consumer 界面贵得多——TUM 2025-10..11 实测 €100 市价往返 {rt}%（约合单边 {one_way}% 含点差）。请使用 {pro_product} 或其 API 以获得公布费率，或用 compare_interface_costs 查看完整对比。",
  },
  iface_advice_switch: {
    en: "{exchange} runs two price tags: the consumer {consumer_product} charges ≈{one_way}% per side all-in, while {pro_product} costs {pro_taker}% taker / {maker}% maker on the same account (measured €100 consumer round-trip: {rt}%).",
    zh: "{exchange} 存在两套价格：consumer 界面「{consumer_product}」单边全成本约 {one_way}%，而同一账户的 {pro_product} 仅 taker {pro_taker}% / maker {maker}%（实测 €100 consumer 往返：{rt}%）。",
  },
  iface_savings_clause: {
    en: " Switching interfaces is free and saves ≈{annual}/yr at {vol}/mo.",
    zh: " 切换界面免费，按每月 {vol} 交易额计算，一年可省约 {annual}。",
  },
  iface_sub_note: {
    en: " {sub_name} (${fee}/mo) waives consumer-app fees on up to ${waiver}/mo of volume — embedded spreads still apply.",
    zh: " {sub_name}（${fee}/月）可豁免最多 ${waiver}/月 consumer 交易额的手续费——内嵌点差仍照收。",
  },
  iface_sub_note_nocap: {
    en: " {sub_name} (${fee}/mo) waives consumer-app trading fees up to the plan's own caps — embedded spreads still apply.",
    zh: " {sub_name}（${fee}/月）可在套餐自身额度内豁免 consumer 交易手续费——内嵌点差仍照收。",
  },
  iface_advice_passthrough: {
    en: "{exchange}'s consumer {consumer_product} routes into the PRO order book at published fees — measured €100 round-trip {rt}% with only {hidden} pp hidden markup, the transparency benchmark of the six TUM platforms. There is no cheaper hidden tier to unlock here.",
    zh: "{exchange} 的 consumer 界面「{consumer_product}」直接按公布费率走 PRO 订单簿——实测 €100 往返 {rt}%、隐藏加价仅 {hidden} 个百分点，是 TUM 六平台中的透明度标杆。这里没有更便宜但被隐藏的档位。",
  },
  iface_advice_broker_only: {
    en: "{exchange} is a spread-model brokerage: the quoted premium IS the fee (already priced into every fee comparison here), so there is no separate Pro tier to switch to. Measured €100 round-trip: {rt}% ({hidden} pp above the published premium).{fusion}",
    zh: "{exchange} 是点差模式券商：报价中的加价就是手续费（本工具所有费率对比已按此计价），因此没有单独的 Pro 界面可切换。实测 €100 往返 {rt}%（比公布加价高 {hidden} 个百分点）。{fusion}",
  },
  iface_fusion_note: {
    en: " The separate Fusion order book (commissions from ~0.02%) is a different product interface.",
    zh: " 其独立的 Fusion 订单簿（佣金约 0.02% 起）是另一个产品界面。",
  },
  iface_advice_unmeasured: {
    en: "{exchange}'s consumer {consumer_product} embeds ≈{one_way}% per the venue's own disclosure — no third-party real-money measurement exists yet, so treat the figure as unverified; the {pro_product} book ({pro_taker}% taker) is the verifiable benchmark.",
    zh: "{exchange} 的 consumer 界面「{consumer_product}」按其自身披露内嵌约 {one_way}%——目前没有第三方实测数据，请将该数字视为未经证实；{pro_product} 订单簿（taker {pro_taker}%）才是可验证的基准。",
  },
  iface_study_summary: {
    en: "Evidence: TUM Pricing Transparency Study (50 real-money €100 round-trips, six MiCA-licensed EU platforms, 2025-10..11) replicated by Frankfurt School (432 round-trips, 2026-03). Retail-interface round-trips range 13x: Bitvavo 0.58% < BSDEX 0.88% < Bison 2.58% < Kraken app 5.81% < Bitpanda 6.23% < Coinbase 7.49%; on broker-model platforms published fees capture less than half of actual cost (hidden markups 3.8-4.5 pp), and MiCA Art. 78 best-execution duties provide no consumer-detectable spread disclosure.",
    zh: "证据：TUM 定价透明度研究（2025-10..11，六家 MiCA 持牌欧盟平台、50 笔 €100 真实资金往返）+ 法兰克福学派复现（2026-03，432 笔）。零售界面往返成本相差 13 倍：Bitvavo 0.58% < BSDEX 0.88% < Bison 2.58% < Kraken app 5.81% < Bitpanda 6.23% < Coinbase 7.49%；券商模式平台的公布费用不足实际成本的一半（隐藏加价 3.8-4.5 个百分点），且 MiCA 第 78 条最佳执行义务并未带来用户可感知的点差披露。",
  },
  iface_tool_advice: {
    en: "Same venue, two price tags: before choosing WHERE to trade, check WHICH interface you are on. Consumer apps embed spreads and flat fees the schedule never shows; every venue above lists its consumer product, the PRO benchmark, and the measurable gap. Pass monthly_volume_usd to price the annual excess.",
    zh: "同一场馆、两套价格：在决定「去哪交易」之前，先确认「用哪个界面」。consumer 应用会把点差和固定费藏进报价；上面每个场馆都列出了 consumer 产品、PRO 基准与可量化的差距。传入 monthly_volume_usd 可计算一年多花的钱。",
  },
} as const satisfies Record<string, Template>;

export type MessageKey = keyof typeof MSG;

/** Interpolate a catalog template for the requested language. */
export function t(
  lang: Lang,
  key: MessageKey,
  params: Record<string, unknown> = {},
): string {
  const tpl: Template = MSG[key];
  const raw = tpl[lang] ?? tpl.en;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m,
  );
}

/** zh display labels for the persona dominant-cost keys. */
export const PERSONA_COST_LABELS: Record<Lang, Record<string, string>> = {
  en: {
    trading_fee: "trading fees",
    funding: "funding",
    execution: "execution (spread/slippage)",
    withdrawal: "withdrawal fees",
    fiat: "fiat on/off-ramping",
  },
  zh: {
    trading_fee: "交易手续费",
    funding: "资金费",
    execution: "执行成本（点差/滑点）",
    withdrawal: "提币手续费",
    fiat: "法币出入金",
  },
};
