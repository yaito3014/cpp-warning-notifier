#include <iostream>

#warning "WARNNING: This is a warning message"

[[nodiscard]] int func() { return 42; }

int main() {
  int unused_variable = 42;
  func();
  std::cout << "Hello, World!" << std::endl;
}
