// Original OpenHarness offline instrument. JUCE retains its own license.
#include <juce_audio_basics/juce_audio_basics.h>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <string>

int main(int argc, char** argv) {
    if (argc != 7) return 2;
    const std::string shape = argv[2];
    const double frequency = std::stod(argv[3]), attack = std::stod(argv[4]);
    const double brightness = std::stod(argv[5]), duration = std::stod(argv[6]);
    constexpr int rate = 44100;
    const auto count = static_cast<int>(rate * duration);
    if (count <= 0 || count > rate * 8 || frequency < 110 || frequency > 880) return 3;
    juce::AudioBuffer<float> buffer(1, count);
    juce::ADSR envelope;
    envelope.setSampleRate(rate);
    envelope.setParameters({static_cast<float>(attack), 0.05f, 0.85f, 0.05f});
    double filtered = 0;
    int lastSegment = -1;
    const int notes[] = {0, 7, 12, 3};
    const double alpha = 1 - std::exp(-2 * juce::MathConstants<double>::pi * (250 + 5000 * brightness) / rate);
    for (int i = 0; i < count; ++i) {
        const double t = static_cast<double>(i) / rate;
        const int segment = std::min(3, static_cast<int>(4 * t / duration));
        if (segment != lastSegment) { envelope.reset(); envelope.noteOn(); lastSegment = segment; }
        const double local = t - segment * duration / 4;
        const double hz = frequency * std::pow(2., notes[segment] / 12.);
        const double phase = std::fmod(t * hz, 1.);
        double value = std::sin(phase * juce::MathConstants<double>::twoPi);
        if (shape == "triangle") value = 1 - 4 * std::abs(phase - .5);
        if (shape == "saw") {
            value = 0;
            for (int n = 1; n < std::min(24, static_cast<int>(rate / (2 * hz))); ++n)
                value += std::sin(juce::MathConstants<double>::twoPi * phase * n) / n;
            value *= .5;
        }
        if (duration / 4 - local < .05) envelope.noteOff();
        filtered += alpha * (value - filtered);
        buffer.setSample(0, i, static_cast<float>(filtered * envelope.getNextSample() * .3));
    }
    std::ofstream file(argv[1], std::ios::binary);
    auto u16 = [&file](uint16_t n) { file.put(n & 255); file.put((n >> 8) & 255); };
    auto u32 = [&file](uint32_t n) { for (int j=0;j<4;++j) file.put((n >> (j*8)) & 255); };
    file.write("RIFF",4); u32(36 + count*2); file.write("WAVEfmt ",8); u32(16); u16(1); u16(1);
    u32(rate); u32(rate*2); u16(2); u16(16); file.write("data",4); u32(count*2);
    for (int i=0;i<count;++i) u16(static_cast<uint16_t>(static_cast<int16_t>(buffer.getSample(0,i)*32767)));
    return file.good() ? 0 : 4;
}
