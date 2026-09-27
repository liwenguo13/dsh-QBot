#include "mini_json.hpp"
#include <cmath>
#include <iostream>
#include <sstream>
#include <string>

static const char* VERSION = "0.3.0-cpp-kernel";

static double number_or(const mjson::Json& obj, const std::string& key, double fallback) {
    const auto& v = obj[key];
    return v.is_number() ? v.as_double() : fallback;
}

static mjson::Json risk_plan(const mjson::Json& input, bool with_order_plan) {
    const double equity = number_or(input, "equity", 0.0);
    const double entry = number_or(input, "entry", 0.0);
    const double stop = number_or(input, "stop", 0.0);
    const double risk_pct = number_or(input, "risk_pct", 1.0);
    const double max_notional = number_or(input, "max_notional", 2000.0);
    const double max_leverage = number_or(input, "max_leverage", 5.0);
    const double take_profit = number_or(input, "take_profit", 0.0);

    mjson::Json out = mjson::Json::object();
    if (equity <= 0 || entry <= 0 || stop <= 0 || entry == stop) {
        out["ok"] = mjson::Json(false);
        out["error"] = mjson::Json("equity, entry and stop must be positive and entry != stop");
        return out;
    }
    const double risk_amount = equity * risk_pct / 100.0;
    const double per_unit = std::fabs(entry - stop);
    double qty = risk_amount / per_unit;
    double notional = qty * entry;
    if (notional > max_notional) {
        qty *= max_notional / notional;
        notional = max_notional;
    }
    const double leverage_needed = notional / equity;
    if (leverage_needed > max_leverage) {
        qty *= max_leverage / leverage_needed;
        notional = qty * entry;
    }
    out["ok"] = mjson::Json(true);
    out["engine"] = mjson::Json(with_order_plan ? "cpp-order-plan" : "cpp-risk");
    out["equity"] = mjson::Json(equity);
    out["entry"] = mjson::Json(entry);
    out["stop"] = mjson::Json(stop);
    out["per_unit_risk"] = mjson::Json(per_unit);
    out["risk_amount"] = mjson::Json(risk_amount);
    out["qty"] = mjson::Json(qty);
    out["notional"] = mjson::Json(notional);
    out["leverage_needed"] = mjson::Json(notional / equity);
    if (take_profit > 0) {
        out["take_profit"] = mjson::Json(take_profit);
        out["reward_risk"] = mjson::Json(std::fabs(take_profit - entry) / per_unit);
    }
    return out;
}

static int risk_check() {
    std::ostringstream buffer;
    buffer << std::cin.rdbuf();
    std::cout << risk_plan(mjson::Json::parse(buffer.str()), false).dump(2) << "\n";
    return 0;
}

static int order_plan() {
    std::ostringstream buffer;
    buffer << std::cin.rdbuf();
    mjson::Json result = risk_plan(mjson::Json::parse(buffer.str()), true);
    std::cout << result.dump(2) << "\n";
    return result["ok"].as_bool() ? 0 : 2;
}

static int paper_fill() {
    std::ostringstream buffer;
    buffer << std::cin.rdbuf();
    mjson::Json input = mjson::Json::parse(buffer.str());
    const auto& position = input["position"];
    const auto& fill = input["fill"];
    const double wallet = number_or(input, "wallet", 0.0);
    const double old_qty = number_or(position, "qty", 0.0);
    const double old_entry = number_or(position, "entry_price", number_or(position, "entry", 0.0));
    const std::string side = fill["side"].as_string("buy");
    const double fill_qty = std::fabs(number_or(fill, "qty", 0.0));
    const double fill_price = number_or(fill, "price", 0.0);
    const double fee_rate = number_or(fill, "fee_rate", 0.0005);
    if (fill_qty <= 0 || fill_price <= 0) {
        mjson::Json err = mjson::Json::object();
        err["ok"] = mjson::Json(false);
        err["error"] = mjson::Json("fill.qty and fill.price must be positive");
        std::cout << err.dump(2) << "\n";
        return 2;
    }
    const double signed_fill = side == "sell" ? -fill_qty : fill_qty;
    const double fee = fill_qty * fill_price * fee_rate;
    double realized = 0.0;
    double new_qty = old_qty;
    double new_entry = old_entry;
    if (std::fabs(old_qty) < 1e-15) {
        new_qty = signed_fill;
        new_entry = fill_price;
    } else if (old_qty * signed_fill > 0) {
        new_qty = old_qty + signed_fill;
        new_entry = (std::fabs(old_qty) * old_entry + fill_qty * fill_price) / std::fabs(new_qty);
    } else {
        const double closing = std::min(fill_qty, std::fabs(old_qty));
        realized = old_qty > 0 ? closing * (fill_price - old_entry) : closing * (old_entry - fill_price);
        new_qty = old_qty + signed_fill;
        if (std::fabs(new_qty) < 1e-15) {
            new_qty = 0.0;
            new_entry = 0.0;
        } else if (old_qty * new_qty > 0) {
            // partial close: keep original entry
        } else {
            new_entry = fill_price;
        }
    }
    mjson::Json out = mjson::Json::object();
    out["ok"] = mjson::Json(true);
    out["engine"] = mjson::Json("cpp-paper-ledger");
    out["wallet"] = mjson::Json(wallet + realized - fee);
    mjson::Json pos = mjson::Json::object();
    pos["qty"] = mjson::Json(new_qty);
    pos["entry_price"] = mjson::Json(new_entry);
    out["position"] = pos;
    out["realized_pnl"] = mjson::Json(realized);
    out["fee"] = mjson::Json(fee);
    std::cout << out.dump(2) << "\n";
    return 0;
}


static void paper_apply(std::map<std::string, std::pair<double, double>>& positions,
                        double& cash, double& realized, double& fees,
                        const std::string& symbol, const std::string& side,
                        double qty, double price, double fee_rate) {
    auto it = positions.find(symbol);
    const double old_qty = it == positions.end() ? 0.0 : it->second.first;
    const double old_entry = it == positions.end() ? 0.0 : it->second.second;
    const double signed_fill = side == "sell" ? -qty : qty;
    const double fee = qty * price * fee_rate;
    fees += fee;
    cash -= fee;
    if (std::fabs(old_qty) < 1e-15) {
        positions[symbol] = {signed_fill, price};
        return;
    }
    if (old_qty * signed_fill > 0) {
        const double new_qty = old_qty + signed_fill;
        const double new_entry = (std::fabs(old_qty) * old_entry + qty * price) / std::fabs(new_qty);
        positions[symbol] = {new_qty, new_entry};
        return;
    }
    const double closing = std::min(qty, std::fabs(old_qty));
    const double pnl = old_qty > 0 ? closing * (price - old_entry) : closing * (old_entry - price);
    realized += pnl;
    cash += pnl;
    const double new_qty = old_qty + signed_fill;
    if (std::fabs(new_qty) < 1e-15) {
        positions.erase(symbol);
    } else if (old_qty * new_qty > 0) {
        positions[symbol] = {new_qty, old_entry};
    } else {
        positions[symbol] = {new_qty, price};
    }
}

static int paper_sim() {
    std::ostringstream buffer;
    buffer << std::cin.rdbuf();
    mjson::Json input = mjson::Json::parse(buffer.str());
    const double wallet = number_or(input, "wallet", 0.0);
    const double slippage_bps = number_or(input, "slippage_bps", 2.0);
    const double slip = slippage_bps / 10000.0;
    const double default_fee_rate = number_or(input, "fee_rate", 0.0005);
    double cash = wallet;
    double realized = 0.0;
    double fees = 0.0;
    double funding_pnl = 0.0;
    std::map<std::string, std::pair<double, double>> positions;
    mjson::Json curve = mjson::Json::array();

    const auto& nodes = input["nodes"].arr;
    for (std::size_t index = 0; index < nodes.size(); ++index) {
        const auto& node = nodes[index];
        const auto& prices = node["prices"].obj;
        const auto& funding = node["funding_rates"].obj;
        for (const auto& fill : node["fills"].arr) {
            const std::string symbol = fill["symbol"].as_string();
            if (symbol.empty()) continue;
            const double raw_price = number_or(fill, "price", 0.0);
            if (raw_price <= 0) continue;
            const double fee_rate = number_or(fill, "fee_rate", default_fee_rate);
            if (fill["close"].as_bool(false)) {
                auto position_it = positions.find(symbol);
                if (position_it == positions.end()) continue;
                const double qty = std::fabs(position_it->second.first);
                const std::string side = position_it->second.first > 0 ? "sell" : "buy";
                if (qty <= 0) continue;
                const double price = side == "sell" ? raw_price * (1.0 - slip) : raw_price * (1.0 + slip);
                paper_apply(positions, cash, realized, fees, symbol, side, qty, price, fee_rate);
                continue;
            }
            const std::string side = fill["side"].as_string("buy");
            const double qty = std::fabs(number_or(fill, "qty", 0.0));
            if (qty <= 0) continue;
            const double price = side == "sell" ? raw_price * (1.0 - slip) : raw_price * (1.0 + slip);
            paper_apply(positions, cash, realized, fees, symbol, side, qty, price, fee_rate);
        }
        for (auto& kv : positions) {
            const std::string& symbol = kv.first;
            const double qty = kv.second.first;
            auto price_it = prices.find(symbol);
            const double mark = price_it == prices.end() ? kv.second.second : price_it->second.as_double(kv.second.second);
            auto rate_it = funding.find(symbol);
            const double rate = rate_it == funding.end() ? 0.0 : rate_it->second.as_double(0.0);
            const double payment = -qty * mark * rate;
            cash += payment;
            funding_pnl += payment;
        }
        double equity = cash;
        for (const auto& kv : positions) {
            const std::string& symbol = kv.first;
            const double qty = kv.second.first;
            const double entry = kv.second.second;
            auto price_it = prices.find(symbol);
            const double mark = price_it == prices.end() ? entry : price_it->second.as_double(entry);
            equity += qty * (mark - entry);
        }
        mjson::Json row = mjson::Json::object();
        row["index"] = mjson::Json((std::int64_t)index);
        row["equity"] = mjson::Json(equity);
        curve.arr.push_back(row);
    }

    mjson::Json out = mjson::Json::object();
    out["ok"] = mjson::Json(true);
    out["engine"] = mjson::Json("cpp-paper-sim");
    out["wallet"] = mjson::Json(cash);
    out["realized_pnl"] = mjson::Json(realized);
    out["fees"] = mjson::Json(fees);
    out["funding_pnl"] = mjson::Json(funding_pnl);
    out["equity_curve"] = curve;
    std::cout << out.dump(2) << "\n";
    return 0;
}

static int selftest() {
    const std::string sample = R"({"equity":10000,"entry":50000,"stop":49000,"risk_pct":1,"max_notional":2000,"max_leverage":5,"take_profit":52000})";
    std::istringstream in(sample);
    std::streambuf* old = std::cin.rdbuf(in.rdbuf());
    mjson::Json result = risk_plan(mjson::Json::parse(sample), true);
    std::cin.rdbuf(old);
    std::cout << result.dump(2) << "\n";
    return result["ok"].as_bool() ? 0 : 1;
}

int main(int argc, char** argv) {
    std::string cmd = argc > 1 ? argv[1] : "";
    if (cmd == "--version" || cmd == "-v") {
        std::cout << "qbot_cpp " << VERSION << "\n";
        return 0;
    }
    if (cmd == "--selftest") return selftest();
    if (cmd == "--risk-check") return risk_check();
    if (cmd == "--order-plan") return order_plan();
    if (cmd == "--paper-fill") return paper_fill();
    if (cmd == "--paper-sim") return paper_sim();
    std::cout << "qbot_cpp " << VERSION << "\n";
    std::cout << "usage: qbot_cpp --risk-check|--order-plan|--paper-fill < input.json\n";
    return 0;
}
