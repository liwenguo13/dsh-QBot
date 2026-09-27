CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Isrc
LDFLAGS ?= -lssl -lcrypto -lpthread

TARGET := qbot_cpp
SRC := $(wildcard src/*.cpp)

all: $(TARGET)

$(TARGET): $(SRC) src/mini_json.hpp
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDFLAGS)

selftest: $(TARGET)
	./$(TARGET) --selftest

clean:
	rm -f $(TARGET)

.PHONY: all selftest clean
