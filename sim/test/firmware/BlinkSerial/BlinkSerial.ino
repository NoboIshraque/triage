// Blink that also says so on the serial port (ROADMAP PA-3's upload test): an
// Arduino sketch folder, built by arduino-cli as the Arduino IDE builds it.
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("Triage blink ready");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  report("on");
  delay(200);
  digitalWrite(LED_BUILTIN, LOW);
  report("off");
  delay(200);
}

// Defined after its first use: arduino-cli's ctags adds the prototype.
void report(const char *state) {
  Serial.print("LED ");
  Serial.println(state);
}
