#pragma once
// Minimal JSON parser/dumper for the C++ QBot core (no third-party deps).
#include <cctype>
#include <cmath>
#include <cstdint>
#include <functional>
#include <iomanip>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace mjson {

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };
    Type type = Type::Null;
    bool boolean = false;
    double number = 0.0;
    std::string str;
    std::vector<Json> arr;
    std::map<std::string, Json> obj;

    Json() = default;
    explicit Json(bool v) : type(Type::Bool), boolean(v) {}
    explicit Json(double v) : type(Type::Number), number(v) {}
    explicit Json(int v) : type(Type::Number), number((double)v) {}
    explicit Json(std::int64_t v) : type(Type::Number), number((double)v) {}
    explicit Json(const std::string& v) : type(Type::String), str(v) {}
    explicit Json(const char* v) : type(Type::String), str(v ? v : "") {}

    static Json object() { Json j; j.type = Type::Object; return j; }
    static Json array() { Json j; j.type = Type::Array; return j; }

    bool is_null() const { return type == Type::Null; }
    bool is_object() const { return type == Type::Object; }
    bool is_array() const { return type == Type::Array; }
    bool is_string() const { return type == Type::String; }
    bool is_number() const { return type == Type::Number; }
    bool is_bool() const { return type == Type::Bool; }

    const Json& operator[](const std::string& key) const {
        static const Json null_value;
        if (type != Type::Object) return null_value;
        auto it = obj.find(key);
        return it == obj.end() ? null_value : it->second;
    }
    Json& operator[](const std::string& key) { type = Type::Object; return obj[key]; }
    const Json& operator[](std::size_t idx) const {
        static const Json null_value;
        if (type != Type::Array || idx >= arr.size()) return null_value;
        return arr[idx];
    }
    Json& operator[](std::size_t idx) { type = Type::Array; if (idx >= arr.size()) arr.resize(idx + 1); return arr[idx]; }

    std::string as_string(const std::string& def = "") const {
        if (type == Type::String) return str;
        if (type == Type::Number) return number_to_string(number);
        if (type == Type::Bool) return boolean ? "true" : "false";
        return def;
    }
    double as_double(double def = 0.0) const {
        if (type == Type::Number) return number;
        if (type == Type::String) { try { return std::stod(str); } catch (...) { return def; } }
        if (type == Type::Bool) return boolean ? 1.0 : 0.0;
        return def;
    }
    std::int64_t as_int(std::int64_t def = 0) const {
        if (type == Type::Number) return (std::int64_t)std::llround(number);
        if (type == Type::String) { try { return std::stoll(str); } catch (...) { return def; } }
        return def;
    }
    bool as_bool(bool def = false) const {
        if (type == Type::Bool) return boolean;
        if (type == Type::Number) return number != 0.0;
        if (type == Type::String) return str == "true" || str == "1";
        return def;
    }

    size_t size() const { return type == Type::Array ? arr.size() : (type == Type::Object ? obj.size() : 0); }

    // ---------------- parsing ----------------
    static Json parse(const std::string& text) {
        Parser p(text);
        Json v = p.parse_value();
        p.skip_ws();
        if (!p.at_end()) throw std::runtime_error("JSON: trailing characters");
        return v;
    }

    static Json parse_file(const std::string& path);
    std::string dump(int indent = -1) const;

    static std::string number_to_string(double v) {
        if (!std::isfinite(v)) return "0";
        std::ostringstream os;
        if (std::fabs(v - std::llround(v)) < 1e-12 && std::fabs(v) < 1e15)
            os << (std::int64_t)std::llround(v);
        else {
            os << std::setprecision(15) << v;
        }
        return os.str();
    }

private:
    struct Parser {
        const std::string& s; size_t i = 0;
        explicit Parser(const std::string& text) : s(text) {}
        bool at_end() const { return i >= s.size(); }
        void skip_ws() { while (!at_end() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i; }
        char peek() const { return at_end() ? '\0' : s[i]; }
        char get() { return at_end() ? '\0' : s[i++]; }
        void expect(char c) { skip_ws(); if (get() != c) throw std::runtime_error(std::string("JSON: expected ") + c); }
        bool consume(const char* lit) {
            size_t n = std::char_traits<char>::length(lit);
            if (s.compare(i, n, lit) == 0) { i += n; return true; }
            return false;
        }
        Json parse_value() {
            skip_ws();
            char c = peek();
            if (c == '{') return parse_object();
            if (c == '[') return parse_array();
            if (c == '"') return Json(parse_string());
            if (c == 't' || c == 'f') { if (consume("true")) return Json(true); if (consume("false")) return Json(false); throw std::runtime_error("JSON: bad literal"); }
            if (c == 'n') { if (consume("null")) return Json(); throw std::runtime_error("JSON: bad null"); }
            if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
            throw std::runtime_error("JSON: unexpected character");
        }
        Json parse_object() {
            Json o = Json::object(); expect('{'); skip_ws();
            if (peek() == '}') { ++i; return o; }
            while (true) {
                skip_ws(); std::string key = parse_string(); expect(':');
                o.obj[key] = parse_value(); skip_ws();
                char c = get();
                if (c == '}') break;
                if (c != ',') throw std::runtime_error("JSON: expected , or }");
            }
            return o;
        }
        Json parse_array() {
            Json a = Json::array(); expect('['); skip_ws();
            if (peek() == ']') { ++i; return a; }
            while (true) {
                a.arr.push_back(parse_value()); skip_ws();
                char c = get();
                if (c == ']') break;
                if (c != ',') throw std::runtime_error("JSON: expected , or ]");
            }
            return a;
        }
        std::string parse_string() {
            std::string out; expect('"');
            while (!at_end()) {
                char c = get();
                if (c == '"') return out;
                if (c == '\\') {
                    char e = get();
                    switch (e) {
                        case '"': out.push_back('"'); break;
                        case '\\': out.push_back('\\'); break;
                        case '/': out.push_back('/'); break;
                        case 'b': out.push_back('\b'); break;
                        case 'f': out.push_back('\f'); break;
                        case 'n': out.push_back('\n'); break;
                        case 'r': out.push_back('\r'); break;
                        case 't': out.push_back('\t'); break;
                        case 'u': {
                            unsigned code = 0; for (int k = 0; k < 4; ++k) { char h = get(); code <<= 4; if (h >= '0' && h <= '9') code |= (h - '0'); else if (h >= 'a' && h <= 'f') code |= (h - 'a' + 10); else if (h >= 'A' && h <= 'F') code |= (h - 'A' + 10); else throw std::runtime_error("JSON: bad unicode"); }
                            if (code < 0x80) out.push_back((char)code);
                            else if (code < 0x800) { out.push_back((char)(0xC0 | (code >> 6))); out.push_back((char)(0x80 | (code & 0x3F))); }
                            else { out.push_back((char)(0xE0 | (code >> 12))); out.push_back((char)(0x80 | ((code >> 6) & 0x3F))); out.push_back((char)(0x80 | (code & 0x3F))); }
                            break;
                        }
                        default: throw std::runtime_error("JSON: bad escape");
                    }
                } else out.push_back(c);
            }
            throw std::runtime_error("JSON: unterminated string");
        }
        Json parse_number() {
            size_t start = i;
            if (peek() == '-') ++i;
            while (!at_end() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) ++i;
            return Json(std::stod(s.substr(start, i - start)));
        }
    };
};

inline std::string Json::dump(int indent) const {
    std::ostringstream os;
    std::function<void(const Json&, int)> put = [&](const Json& v, int depth) {
        std::string pad = indent >= 0 ? std::string((size_t)(depth * indent), ' ') : "";
        switch (v.type) {
            case Type::Null: os << "null"; break;
            case Type::Bool: os << (v.boolean ? "true" : "false"); break;
            case Type::Number: os << number_to_string(v.number); break;
            case Type::String: {
                os << '"';
                for (char c : v.str) {
                    switch (c) {
                        case '"': os << "\\\""; break;
                        case '\\': os << "\\\\"; break;
                        case '\n': os << "\\n"; break;
                        case '\r': os << "\\r"; break;
                        case '\t': os << "\\t"; break;
                        default: os << c;
                    }
                }
                os << '"'; break;
            }
            case Type::Array: {
                os << "[";
                for (size_t k = 0; k < v.arr.size(); ++k) {
                    if (k) os << ",";
                    if (indent >= 0) os << "\n" << std::string((size_t)((depth + 1) * indent), ' ');
                    put(v.arr[k], depth + 1);
                }
                if (indent >= 0 && !v.arr.empty()) os << "\n" << pad;
                os << "]"; break;
            }
            case Type::Object: {
                os << "{";
                bool first = true;
                for (auto& kv : v.obj) {
                    if (!first) os << ",";
                    first = false;
                    if (indent >= 0) os << "\n" << std::string((size_t)((depth + 1) * indent), ' ');
                    os << '"' << kv.first << "\":";
                    if (indent >= 0) os << " ";
                    put(kv.second, depth + 1);
                }
                if (indent >= 0 && !v.obj.empty()) os << "\n" << pad;
                os << "}"; break;
            }
        }
    };
    put(*this, 0);
    return os.str();
}

} // namespace mjson
