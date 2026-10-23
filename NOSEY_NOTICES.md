SkillSense detection engine and registry modules

Ported from https://github.com/rigerc/skillsense at commit 408680444de16576af1e9e3f1235112627102834.
The SkillSense UI code has not been reused.

MIT License

Copyright (c) 2026 skillsense contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Registry configuration behavior

The identity remapping in registry-tools/configure-registry.mjs incorporates
behavior from https://github.com/rigerc/nosey-registry-template at commit
fe4dee484484daf373b58d4922de6a9e4f702d3c, distributed under the Apache License 2.0.
Nosey's version adds explicit registry/tool roots, packaged generator execution,
regular-file checks, and a reusable configuration interface. The Apache license
is included at registry-tools/LICENSE-APACHE-2.0 in Nosey and exported as
NOSEY_LICENSE_APACHE_2_0 in registries.
