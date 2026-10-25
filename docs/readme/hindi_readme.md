<div align="center">

[English](../../README.md) · [简体中文](../readme/README_zh.md) · [繁體中文](../readme/README_zh-TW.md) · [日本語](../readme/README_ja.md) · [한국어](../readme/README_ko.md) · [Türkçe](../readme/README_tr.md) · [Русский](../readme/README_ru.md) · [Tiếng Việt](../readme/README_vi.md) · [ไทย](../readme/README_th.md) · [Deutsch](../readme/README_de.md) · [Español](../readme/README_es.md) · [Français](../readme/README_fr.md) · [Українська](../readme/README_uk.md) · [Polski](../readme/README_pl.md) · [Português (Brasil)](../readme/README_pt-BR.md) · [العربية](../readme/README_ar.md) · [فارسی](../readme/README_fa.md) · [Bahasa Indonesia](../readme/README_id.md) · [Italiano](../readme/README_it.md) · **हिन्दी**
· [Ελληνικά](../readme/README_el.md) · [മലയാളം](../readme/README_ml.md) · [Roman Urdu](../readme/README_ur-Latn.md) · [Română](../readme/README_ro.md)

# REA: Reverse Engineer Anything (किसी भी चीज़ का रिवर्स इंजीनियरिंग करें)

### बायनेरियों, ऐप्स और रनटाइम व्यवहार में रिवर्स इंजीनियरिंग के लिए एक संपूर्ण MCP।

**आपको पसंद आने वाला कोई फ़ीचर देखें। समझें कि यह कैसे काम करता है, बाइनरी स्तर तक।**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#आप-क्या-विश्लेषण-कर-सकते-हैं)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[वेबसाइट](https://rea.tools/) · [गाइड्स](https://rea.tools/guides/) · [शोकेस](https://rea.tools/showcase/)**

[क्विक स्टार्ट](#क्विक-स्टार्ट) · [REA कैसे काम करता है](#rea-कैसे-काम-करता-है) · [आप क्या विश्लेषण कर सकते हैं](#आप-क्या-विश्लेषण-कर-सकते-हैं) · [शोकेस](#शोकेस) · [अक्सर पूछे जाने वाले प्रश्न (FAQ)](#अक्सर-पूछे-जाने-वाले-प्रश्न-faq) · [दस्तावेज़ीकरण](#दस्तावेज़ीकरण)

<code>npx rea-agents setup</code>

</div>

> [!IMPORTANT]
> REA केवल आधिकारिक स्रोतों से प्राप्त करें: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), या [rea-agents npm पैकेज](https://www.npmjs.com/package/rea-agents)। केवल इन आधिकारिक स्रोतों से ही इंस्टॉलेशन और रिलीज़ लिंक का पालन करें।

<div align="center">

<br />

<img src="../assets/rea-hopper-analysis.png" alt="REA नेटिव बाइनरी का निरीक्षण करते समय Hopper के अंदर अपना विश्लेषण ब्रिज लॉन्च कर रहा है" width="1200" />

<br /><br />

<table aria-label="REA समुदाय">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>रिवर्स इंजीनियरिंग समुदाय में शामिल हों</strong>
  </a><br />
  <sub>Discord · सवाल और जवाब · प्रदर्शन</sub>
</td>
</tr>
</table>

<br />

</div>

---

क्या आपको किसी ऐप में कोई ऐसा फ़ीचर दिखता है जिसे आप अपने प्रोजेक्ट में जोड़ना चाहते हैं? अपने AI एजेंट को REA के माध्यम से इसकी जांच करने के लिए कहें। यह बिना सोर्स कोड के ऐप का निरीक्षण कर सकता है, यह समझा सकता है कि फ़ीचर कैसे काम करता है, सबूत दिखा सकता है, और आपके प्रोजेक्ट के लिए एक संस्करण तैयार कर सकता है।

REA आपके एजेंट को नेटिव बाइनरीज़, जावास्क्रिप्ट और इलेक्ट्रॉन (Electron) ऐप्स, .NET असेंबलीज़ और वेबसाइटों के निरीक्षण के लिए टूल्स से जोड़ता है। आप इन्हीं टूल्स का उपयोग अपने टर्मिनल से भी कर सकते हैं। विश्लेषण स्थानीय रूप से (locally) चलता है।

सेटअप REA को आपके एजेंट के साथ रजिस्टर करता है और उपयुक्त वर्कफ़्लो निर्देश इंस्टॉल करता है। नेटिव विश्लेषण मौजूदा Hopper, Ghidra, या IDA इंस्टॉलेशन का उपयोग कर सकता है। स्थैतिक (Static) जावास्क्रिप्ट विश्लेषण के लिए किसी नेटिव इंजन की आवश्यकता नहीं होती है।

> **सेटअप निर्देशों, चित्रों वाली गाइडों और वास्तविक केस स्टडीज के लिए [REA वेबसाइट पर जाएं](https://rea.tools/)।**

## क्विक स्टार्ट

Linux पर, Ghidra, JADX, फ़र्मवेयर टूल लॉन्च और स्थैतिक JavaScript/Electron विश्लेषण के लिए प्रक्रिया स्वामित्व की जांच हेतु REA के `PATH` पर एक procps-संगत `ps` का होना आवश्यक है।

### अपने एजेंट को सेट अप करें

Node.js और npm इंस्टॉल होने पर, यह कमांड चलाएं:

```bash
npx rea-agents setup
```

अपने एजेंट चुनें, प्रस्तावित परिवर्तनों की समीक्षा करें और उन्हें स्वीकृत करें। सेटअप REA का MCP सर्वर और मिलान वाले वर्कफ़्लो निर्देश जोड़ता है। इसके बाद अपने एजेंट को रीस्टार्ट करें।

सेटअप Claude Code, Codex, Cursor, Gemini CLI, Grok Build और [अन्य एजेंटों](../installation.md#supported-agents) का समर्थन करता है।

### अपने एजेंट से पूछें

```text
Understand how search works in the Notes app, show me the evidence, and build a similar feature for my project.
```

(Notes को अपने लक्षित ऐप और उस फ़ीचर से बदलें जिसे आप समझना चाहते हैं।)

### टर्मिनल का उपयोग करें

किसी निकाले गए जावास्क्रिप्ट/इलेक्ट्रॉन ऐप डायरेक्टरी या ASAR का निरीक्षण करें:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

नियमित उपयोग के लिए `rea` कमांड इंस्टॉल करें:

```bash
npm install --global rea-agents
rea --help
```

### REA को अपडेट करें

नियमित अपडेट के लिए अपने वैश्विक इंस्टॉलेशन पर चलाएं:

```bash
rea update
```

या npx के साथ अपने एजेंट सेटअप को अपडेट करें:

```bash
npx rea-agents@latest setup
```

## REA कैसे काम करता है

आपका एजेंट टारगेट का निरीक्षण करने और संबंधित कोड को ट्रेस करने के लिए MCP के माध्यम से REA को कॉल करता है। REA साक्ष्यों के साथ निष्कर्ष वापस करता है। एजेंट इनका उपयोग व्यवहार को समझाने या किसी कार्यान्वयन को लिखने और परीक्षण करने के लिए करता है।

![REA जांच प्रवाह](../assets/figures/rea-investigation-flow.svg)

## आप क्या विश्लेषण कर सकते हैं

REA के लिए Node.js 22.x (>=22.23.4), 24.x (>=24.22.1), या 26.12.1+ तथा npm की आवश्यकता होती है:

| टारगेट | REA क्या प्रदान करता है | आवश्यकताएं और गाइड |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| डेस्कटॉप इंस्टॉलेशन | रनटाइम उम्मीदवार, सहायक फ़ाइलें, घटक संकेतक | निर्मित निरीक्षण; [डेस्कटॉप अनुप्रयोग](../desktop-applications.md) |
| नेटिव बाइनरी (Native Binaries) | छद्म कोड (Pseudocode), असेंबली, स्ट्रिंग्स, सिंबल और कॉल | Hopper, Ghidra या IDA; [नेटिव विश्लेषण](../native-investigation.md) |
| Go बाइनरी | एंबेडेड कंपाइलर वर्ज़न, मॉड्यूल और बिल्ड सेटिंग्स | निर्मित स्थैतिक ELF/PE/Mach-O निरीक्षण |
| GPU कोड ऑब्जेक्ट | CUDA/HIP टारगेट, कर्नेल पैरामीटर और संसाधन | निर्मित स्थैतिक निरीक्षण; [GPU कोड ऑब्जेक्ट](../gpu-code-objects.md) |
| मॉडल आर्टिफ़ैक्ट (Model Artifacts) | GGUF / safetensors मेटाडेटा, टेन्सर घोषणाएं | निर्मित हेडर निरीक्षण; [मॉडल फ़ाइलें](../model-artifacts.md) |
| Rust बाइनरी | एंबेडेड क्रेड (crate) के नाम, वर्ज़न और निर्भरताएँ | निर्मित स्थैतिक निरीक्षण; [Rust बाइनरी](../rust-binaries.md) |
| Android APK | मेनिफेस्ट घोषणाएं, क्लासेस, डीकंपाइल किए गए मेथड | Headless JADX और JDK; [Android गाइड](../android-analysis.md) |
| जावास्क्रिप्ट / इलेक्ट्रॉन | मॉड्यूल, इम्पोर्ट, सोर्स मैप, रूट और IPC | Node.js और npm; [एप्लिकेशन विश्लेषण](../javascript-application-workflows.md) |
| वेबसाइटें | पेज संरचना, स्क्रिप्ट, नेटवर्क अवलोकन और स्क्रीनशॉट | क्रोमियम-आधारित ब्राउज़र; [ब्राउज़र विश्लेषण](../browser-observation.md) |
| .NET असेंबली | मेटाडेटा, CIL निर्देश और नेटिव निर्भरताएँ | कोई नहीं (केवल स्थैतिक); [मैनेज्ड-कोड गाइड](../managed-code-analysis.md) |

## शोकेस

### DX-Ball: साउंड-पैन गणना का पुनर्निर्माण
एक साउंड कॉल का निरीक्षण करें और अधूरे छद्म कोड (pseudocode) को C में बदलें।

[केस स्टडी पढ़ें](https://rea.tools/showcase/dx-ball/)

### Notion: इलेक्ट्रॉन क्लिपबोर्ड ब्रिज को ट्रेस करना
रेंडरर के क्लिपबोर्ड API को खोजें और मुख्य प्रक्रिया तक इसके IPC का पालन करें।

[केस स्टडी पढ़ें](https://rea.tools/showcase/notion/)

## अक्सर पूछे जाने वाले प्रश्न (FAQ)

<details>
<summary><strong>कौन से एजेंट REA का उपयोग कर सकते हैं?</strong></summary>

कोई भी एजेंट जो स्थानीय MCP सर्वर का समर्थन करता है, जैसे कि Claude Code, Cursor, Codex, Gemini CLI आदि।

</details>

<details>
<summary><strong>क्या मुझे Hopper, Ghidra या IDA की आवश्यकता है?</strong></summary>

गहरे नेटिव बाइनरी विश्लेषण के लिए इनमें से एक की आवश्यकता होती है। जावास्क्रिप्ट और .NET निरीक्षण बिना किसी नेटिव इंजन के काम करते हैं।

</details>

<details>
<summary><strong>क्या REA मेरा ऐप अपलोड करता है?</strong></summary>

नहीं, REA आपके कंप्यूटर पर स्थानीय रूप से विश्लेषण करता है।

</details>

## दस्तावेज

विस्तृत गाइड और दस्तावेज़ीकरण के लिए [rea.tools/guides](https://rea.tools/guides/) पर जाएँ।

## लाइसेंस

[MIT](../../LICENSE) - REA-रचित कोड MIT लाइसेंस के तहत लाइसेंस प्राप्त है।